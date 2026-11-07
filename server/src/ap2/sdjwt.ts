// SD-JWT delegation chains in the AP2 wire format, written after the official
// AP2 Python SDK (google-agentic-commerce/AP2 @ e1ea56d, code/sdk/python/ap2/sdk/sdjwt):
//   root SD-JWT      issuer-signed, payload { delegate_payload: [{"...": digest}], _sd_alg }
//   KB-SD-JWT hop    signed by the previous hop's cnf.jwk; adds iat, aud, nonce, sd_hash;
//                    typ "kb+sd-jwt+kb" when it delegates further (has cnf), "kb+sd-jwt" when terminal
//   chain            tokens joined so that each ends with "~": root~d1~~hop~d2~
// Disclosures are base64url JSON: [salt, value] for array elements, [salt, name, value]
// for object members; a digest is base64url(sha-256(disclosure)).
import { createHash, randomBytes } from 'node:crypto';
import { CompactSign, compactVerify, importJWK, type JWK } from 'jose';

export const SD_ALG = 'sha-256';
export const TYP_TERMINAL = 'kb+sd-jwt';
export const TYP_INTERMEDIATE = 'kb+sd-jwt+kb';

const b64url = (b: Buffer | Uint8Array | string) => Buffer.from(b).toString('base64url');
export const sha256b64url = (s: string) => b64url(createHash('sha256').update(s, 'ascii').digest());
const salt = () => b64url(randomBytes(16));

// Which parts of a mandate are selectively disclosable, from the schema
// annotations x-selectively-disclosable-field / -array.
export interface SdRules {
  fields?: string[]; // object members hidden behind _sd digests
  arrays?: string[]; // arrays (at any depth, by key) whose elements become {"...": digest}
}

function encode(value: unknown, rules: SdRules, out: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => encode(v, rules, out));
  if (!value || typeof value !== 'object') return value;
  const obj: Record<string, unknown> = {};
  const sd: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    let inner = encode(v, rules, out);
    if (rules.arrays?.includes(k) && Array.isArray(inner)) {
      inner = inner.map((el) => {
        const d = b64url(JSON.stringify([salt(), el]));
        out.push(d);
        return { '...': sha256b64url(d) };
      });
    }
    if (rules.fields?.includes(k)) {
      const d = b64url(JSON.stringify([salt(), k, inner]));
      out.push(d);
      sd.push(sha256b64url(d));
    } else obj[k] = inner;
  }
  if (sd.length) obj._sd = sd;
  return obj;
}

async function sign(header: Record<string, unknown>, payload: Record<string, unknown>, key: JWK): Promise<string> {
  const k = await importJWK(key, 'ES256');
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: 'ES256', ...header } as any).sign(k);
}

function issue(payload: unknown, rules: SdRules, extra: Record<string, unknown>) {
  const disclosures: string[] = [];
  const inner = encode(payload, rules, disclosures);
  const top = b64url(JSON.stringify([salt(), inner]));
  disclosures.push(top);
  return { claims: { delegate_payload: [{ '...': sha256b64url(top) }], _sd_alg: SD_ALG, ...extra }, disclosures };
}

const serialize = (jwt: string, disclosures: string[]) => [jwt, ...disclosures].join('~') + '~';

// Root, issuer-signed SD-JWT (e.g. an open mandate signed on the Trusted Surface).
export async function createRoot(payload: unknown, rules: SdRules, issuerKey: JWK): Promise<string> {
  const { claims, disclosures } = issue(payload, rules, {});
  return serialize(await sign(issuerKey.kid ? { kid: issuerKey.kid } : {}, claims, issuerKey), disclosures);
}

export interface Parsed {
  jwt: string;
  disclosures: string[];
  header: Record<string, any>;
  payload: Record<string, any>;
}

export function splitChain(chain: string): string[] {
  if (!chain.endsWith('~')) throw new Error('Malformed SD-JWT chain: must end with "~"');
  return chain.slice(0, -1).split('~~').map((t) => t + '~');
}

export function parse(token: string): Parsed {
  const parts = token.split('~');
  if (parts.at(-1) !== '') throw new Error('Malformed SD-JWT: must end with "~"');
  const [jwt, ...rest] = parts.slice(0, -1);
  const seg = jwt.split('.');
  if (seg.length !== 3) throw new Error('Malformed SD-JWT: issuer JWT must have header.payload.signature');
  const dec = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  return { jwt, disclosures: rest, header: dec(seg[0]), payload: dec(seg[1]) };
}

const sdHash = (p: Parsed) => sha256b64url(serialize(p.jwt, p.disclosures));

// Appends a KB-SD-JWT hop signed by the holder (the key named in the previous hop's cnf).
export async function present(chain: string, payload: unknown, rules: SdRules, holderKey: JWK, aud: string, nonce: string): Promise<string> {
  const prev = parse(splitChain(chain).at(-1)!);
  const terminal = !(payload && typeof payload === 'object' && 'cnf' in payload);
  const { claims, disclosures } = issue(payload, rules, { iat: Math.floor(Date.now() / 1000), aud, nonce, sd_hash: sdHash(prev) });
  const header = { typ: terminal ? TYP_TERMINAL : TYP_INTERMEDIATE, ...(holderKey.kid ? { kid: holderKey.kid } : {}) };
  return chain + '~' + serialize(await sign(header, claims, holderKey), disclosures);
}

// Replaces digests with their disclosed values; fails on a digest with no disclosure.
function resolve(value: unknown, byDigest: Map<string, unknown[]>): unknown {
  if (Array.isArray(value)) {
    return value.map((el) => {
      if (el && typeof el === 'object' && '...' in el) {
        const d = byDigest.get((el as any)['...']);
        if (!d || d.length !== 2) throw new Error('SD-JWT array element has no matching disclosure');
        return resolve(d[1], byDigest);
      }
      return resolve(el, byDigest);
    });
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '_sd') {
      for (const dg of v as string[]) {
        const d = byDigest.get(dg);
        if (!d || d.length !== 3) throw new Error('SD-JWT _sd digest has no matching disclosure');
        out[d[1] as string] = resolve(d[2], byDigest);
      }
    } else if (k !== '_sd_alg') out[k] = resolve(v, byDigest);
  }
  return out;
}

async function verifyOne(p: Parsed, key: JWK) {
  await compactVerify(p.jwt, await importJWK(key, 'ES256'));
  if (p.payload._sd_alg !== SD_ALG) throw new Error(`Unsupported _sd_alg ${p.payload._sd_alg}`);
  const byDigest = new Map(p.disclosures.map((d) => [sha256b64url(d), JSON.parse(Buffer.from(d, 'base64url').toString('utf8')) as unknown[]]));
  return resolve(p.payload, byDigest) as Record<string, any>;
}

export interface VerifiedHop {
  header: Record<string, any>;
  claims: Record<string, any>; // resolved, with delegate_payload[0] = the mandate
  mandate: Record<string, any>;
  leafJwt: string;
}

// Verifies root signature with the issuer key, then each hop with the previous
// hop's cnf.jwk, its sd_hash binding, its typ, and (on the last hop) aud/nonce.
export async function verifyChain(chain: string, issuerKey: JWK, expect?: { aud?: string; nonce?: string }): Promise<VerifiedHop[]> {
  const tokens = splitChain(chain).map(parse);
  const out: VerifiedHop[] = [];
  let key = issuerKey;
  tokens.forEach((t, i) => {
    if (i > 0) {
      const typ = t.header.typ;
      if (typ !== TYP_TERMINAL && typ !== TYP_INTERMEDIATE) throw new Error(`Unexpected hop typ ${typ}`);
      if (t.payload.sd_hash !== sdHash(tokens[i - 1])) throw new Error(`sd_hash mismatch at hop ${i}`);
    }
  });
  for (const [i, t] of tokens.entries()) {
    const claims = await verifyOne(t, key);
    const mandate = claims.delegate_payload?.[0];
    if (!mandate || typeof mandate !== 'object') throw new Error(`Token ${i} has no delegate payload`);
    const last = i === tokens.length - 1;
    if (i > 0 && t.header.typ === TYP_TERMINAL && mandate.cnf) throw new Error('Terminal KB-SD-JWT must not carry cnf');
    if (i > 0 && t.header.typ === TYP_INTERMEDIATE && !mandate.cnf) throw new Error('Intermediate KB-SD-JWT requires cnf');
    if (last && i > 0) {
      if (expect?.aud !== undefined && claims.aud !== expect.aud) throw new Error(`aud mismatch: expected ${expect.aud}, got ${claims.aud}`);
      if (expect?.nonce !== undefined && claims.nonce !== expect.nonce) throw new Error('nonce mismatch');
    }
    out.push({ header: t.header, claims, mandate, leafJwt: t.jwt });
    if (!last) {
      if (!mandate.cnf?.jwk) throw new Error(`Token ${i} delegates without cnf.jwk`);
      key = mandate.cnf.jwk;
    }
  }
  return out;
}

// Plain ES256 JWT (merchant-signed checkout, receipts).
export async function signJwt(payload: Record<string, unknown>, key: JWK, typ = 'JWT'): Promise<string> {
  return sign({ typ, ...(key.kid ? { kid: key.kid } : {}) }, payload, key);
}

export async function verifyJwt(jwt: string, key: JWK): Promise<Record<string, any>> {
  const { payload } = await compactVerify(jwt, await importJWK(key, 'ES256'));
  return JSON.parse(new TextDecoder().decode(payload));
}

// sd_hash of an issued SD-JWT, used as the open checkout mandate reference
// (payment.reference.conditional_transaction_id).
export const tokenSdHash = (token: string) => sdHash(parse(token));
// Receipt reference: hash of the closed (leaf) mandate JWT.
export const leafReference = (chain: string) => sha256b64url(parse(splitChain(chain).at(-1)!).jwt);
