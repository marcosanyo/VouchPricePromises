// LLM access for extraction only (claims, model numbers, catalog audit). The LLM
// never produces prices, probabilities, scores, or verdicts. Output is parsed
// against a zod schema and rejected when it does not match.
import { GoogleGenAI } from '@google/genai';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { config } from './config.ts';
import { UpstreamError, withRetries } from './errors.ts';

// Each Vertex AI call is reported here (model, tokens, duration, status) so
// usage and cost can be audited; wired to the api_calls table by context.
export let onLlmCall: ((rec: { model: string; status: number | null; durationMs: number; inputTokens: number | null; outputTokens: number | null; error?: string }) => void) | undefined;
export function setLlmRecorder(fn: typeof onLlmCall) {
  onLlmCall = fn;
}

const LLM_TIMEOUT_MS = 90_000;

export interface LlmInput {
  system: string;
  prompt: string;
  imageUrls?: string[];
  temperature?: number; // default 0 (extraction); experiments sample at higher values
  thinking?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'; // Gemini thinking level; unset = the model's default
}

let genai: GoogleGenAI | undefined;

// Credentials for Vertex AI: the service-account key named by
// GOOGLE_APPLICATION_CREDENTIALS (local, Cloud Run), or, when only an access
// token is provided (CLOUDSDK_AUTH_ACCESS_TOKEN, as in the cloud dev
// container), that token. Chosen by what the environment sets, never as a retry.
function makeGenai(): GoogleGenAI {
  const cfg = config();
  const token = process.env.CLOUDSDK_AUTH_ACCESS_TOKEN;
  const googleAuthOptions = !process.env.GOOGLE_APPLICATION_CREDENTIALS && token ? { authClient: Object.assign(new OAuth2Client(), { credentials: { access_token: token } }) } : undefined;
  return new GoogleGenAI({ vertexai: true, project: cfg.vertex.project, location: cfg.vertex.location, httpOptions: { timeout: LLM_TIMEOUT_MS }, ...(googleAuthOptions ? { googleAuthOptions: googleAuthOptions as any } : {}) });
}

async function callVertex(input: LlmInput): Promise<string> {
  const cfg = config();
  genai ??= makeGenai();
  const started = Date.now();
  const parts: any[] = [{ text: input.prompt }];
  for (const url of input.imageUrls ?? []) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status} ${url}`);
    const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
    parts.push({ inlineData: { mimeType, data: Buffer.from(await res.arrayBuffer()).toString('base64') } });
  }
  try {
    const res = await genai.models.generateContent({
      model: cfg.vertex.model,
      contents: [{ role: 'user', parts }],
      config: { systemInstruction: input.system, responseMimeType: 'application/json', temperature: input.temperature ?? 0, ...(input.thinking ? { thinkingConfig: { thinkingLevel: input.thinking as any } } : {}) },
    });
    const usage = (res as any).usageMetadata;
    onLlmCall?.({ model: cfg.vertex.model, status: 200, durationMs: Date.now() - started, inputTokens: usage?.promptTokenCount ?? null, outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0) || null });
    const text = res.text;
    if (!text) throw new UpstreamError({ upstream: 'vertex_ai', endpoint: cfg.vertex.model, status: 200, body: res, message: `Vertex AI ${cfg.vertex.model} returned no text` });
    return text;
  } catch (err: any) {
    if (err instanceof UpstreamError) throw err;
    onLlmCall?.({ model: cfg.vertex.model, status: err?.status ?? null, durationMs: Date.now() - started, inputTokens: null, outputTokens: null, error: String(err?.message ?? err).slice(0, 300) });
    throw new UpstreamError({ upstream: 'vertex_ai', endpoint: cfg.vertex.model, status: err?.status ?? null, body: err?.message ?? String(err) });
  }
}

export function llmModelId(): string {
  return config().vertex.model;
}

export async function extractJson<T>(schema: z.ZodType<T>, input: LlmInput): Promise<T> {
  const text = await withRetries(`llm ${llmModelId()}`, 4, () => callVertex(input));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`LLM ${llmModelId()} returned non-JSON: ${text.slice(0, 300)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`LLM ${llmModelId()} output failed validation: ${result.error.message.slice(0, 500)}`);
  }
  return result.data;
}

// ---------- Tool calling (agents) ----------
// The model picks one function and its arguments; the caller validates the
// arguments and runs the function itself.
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export async function callTool(input: LlmInput & { tools: ToolSpec[] }): Promise<{ name: string; args: Record<string, unknown>; text: string | null }> {
  const cfg = config();
  genai ??= makeGenai();
  return withRetries(`llm ${cfg.vertex.model} tools`, 4, async () => {
    const started = Date.now();
    try {
      const res = await genai!.models.generateContent({
        model: cfg.vertex.model,
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
        config: {
          systemInstruction: input.system,
          temperature: input.temperature ?? 0,
          ...(input.thinking ? { thinkingConfig: { thinkingLevel: input.thinking as any } } : {}),
          tools: [{ functionDeclarations: input.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
          toolConfig: { functionCallingConfig: { mode: 'ANY' as any, allowedFunctionNames: input.tools.map((t) => t.name) } },
        },
      });
      const usage = (res as any).usageMetadata;
      onLlmCall?.({ model: cfg.vertex.model, status: 200, durationMs: Date.now() - started, inputTokens: usage?.promptTokenCount ?? null, outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0) || null });
      const call = res.functionCalls?.[0];
      if (!call?.name) throw new UpstreamError({ upstream: 'vertex_ai', endpoint: cfg.vertex.model, status: 200, body: res, message: `Vertex AI ${cfg.vertex.model} returned no function call` });
      return { name: call.name, args: (call.args ?? {}) as Record<string, unknown>, text: null };
    } catch (err: any) {
      if (err instanceof UpstreamError) throw err;
      onLlmCall?.({ model: cfg.vertex.model, status: err?.status ?? null, durationMs: Date.now() - started, inputTokens: null, outputTokens: null, error: String(err?.message ?? err).slice(0, 300) });
      throw new UpstreamError({ upstream: 'vertex_ai', endpoint: cfg.vertex.model, status: err?.status ?? null, body: err?.message ?? String(err) });
    }
  });
}
