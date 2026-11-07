// PayPal Agent Toolkit (@paypal/agent-toolkit) for the merchant agents. Each
// store's agent gets a toolkit bound to that store's own Sandbox seller
// account, limited to the order tools it needs. The toolkit returns errors as
// values; they are raised here as PayPal upstream errors.
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { zodSchema } from 'ai';
import { config } from '../config.ts';
import { UpstreamError } from '../errors.ts';
import type { CallRecord } from '../channel3.ts';
import type { ToolSpec } from '../llm.ts';

const cache = new Map<number, any>();

function tools(slot: number): Record<string, any> {
  let t = cache.get(slot);
  if (!t) {
    const s = config().paypal.sellers.find((x) => x.slot === slot);
    if (!s) throw new Error(`PayPal seller slot ${slot} is not configured`);
    const tk = new PayPalAgentToolkit({ clientId: s.clientId, clientSecret: s.clientSecret, configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } } as any });
    t = tk.getTools();
    cache.set(slot, t);
  }
  return t;
}

// JSON Schema of a toolkit tool, for Gemini function declarations.
export function toolSpec(slot: number, name: 'create_order' | 'get_order' | 'pay_order'): ToolSpec {
  const t = tools(slot)[name];
  const { $schema: _s, ...schema } = zodSchema(t.parameters).jsonSchema as Record<string, unknown>;
  return { name, description: t.description, parameters: schema };
}

// Each call is recorded like any other PayPal call (api_calls, upstream 'paypal').
export async function runTool(slot: number, name: 'create_order' | 'get_order' | 'pay_order', args: Record<string, unknown>, record?: (rec: CallRecord) => void): Promise<any> {
  const started = Date.now();
  const raw = await tools(slot)[name].execute(args, { toolCallId: `${name}-${Date.now()}`, messages: [] });
  const out = typeof raw === 'string' ? JSON.parse(raw) : raw;
  record?.({ endpoint: `agent-toolkit ${name}`, method: 'TOOL', request: args, status: out?.error || out?.ok === false ? (out?.status ?? null) : 200, response: out, durationMs: Date.now() - started });
  if (out?.error || out?.ok === false) {
    throw new UpstreamError({ upstream: 'paypal', endpoint: `agent-toolkit ${name}`, status: out?.status ?? null, body: out, message: `PayPal Agent Toolkit ${name} failed: ${JSON.stringify(out).slice(0, 400)}` });
  }
  return out?.response ?? out;
}
