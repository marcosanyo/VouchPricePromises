// Vouch MCP server (stdio). Lets any MCP host (e.g. Claude) find items with
// staked claims, see why stores rank where they do, buy on PayPal Sandbox with
// the store's staked claims, and check contract status. Stores are anonymised.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { makeCtx } from './context.ts';
import { UpstreamError } from './errors.ts';
import { purchase } from './live.ts';
import { rankGroup, standingClaims } from './market.ts';
import { listGroups } from './replay.ts';
import { CLAIM_LABELS, DEFAULTS, RULE_VERSION, type ClaimType } from './rules.ts';

// What a miss pays, per claim type (the stake is the cap, not the payout).
const REFUND_RULE: Record<ClaimType, string> = {
  lowest_price: 'If another compared store is cheaper within 7 days: refund of the price difference, capped at the stake.',
  no_price_drop: 'If this listing\'s price falls below the price paid within 14 days: refund of the drop, capped at the stake.',
  genuine_sale: 'If the price paid is not at least 10% below the store\'s own 30-day mean: refund of the amount above that threshold, capped at the stake.',
  in_stock: 'If Channel3 listed the offer as out of stock at purchase: refund of the full stake.',
};
import { storeLabel } from './score.ts';
import { verifyPromise } from './verify-promise.ts';

const ctx = makeCtx();
const { db } = ctx;

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, (k, x) => (k === 'domain' || k === 'url' ? undefined : x), 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify(err instanceof UpstreamError ? err.toJSON() : { error: String(err instanceof Error ? err.message : err) }, null, 2) }],
});
const guard = <A,>(fn: (a: A) => Promise<unknown> | unknown) => async (a: A) => {
  try {
    return text(await fn(a));
  } catch (err) {
    return fail(err);
  }
};

function withRefundRules<T extends { ranking: { staked_claims: { claim_type: ClaimType; stake_usd: number }[] }[] }>(r: T): T {
  return { ...r, ranking: r.ranking.map((x) => ({ ...x, staked_claims: x.staked_claims.map((c) => ({ ...c, max_refund_usd: c.stake_usd, refund_rule: REFUND_RULE[c.claim_type] })) })) };
}

const server = new McpServer({ name: 'vouch', version: '0.1.0' });

server.registerTool(
  'find_vouched_products',
  {
    title: 'Find products with staked claims',
    description:
      'Search the Vouch catalogue (real Channel3 products and daily prices). For each matching item, returns the stores selling it ranked by effective cost = price + expected unprotected loss, with the reasons. A staked claim means the store refunds the buyer automatically via PayPal if the claim turns out false; the refund is the shortfall (e.g. the price difference), and the stake is only its cap. Each staked claim includes its exact refund_rule.',
    inputSchema: { query: z.string().describe('Product name, e.g. "Sony WH-1000XM5"'), weight: z.number().min(0).max(10).optional().describe('How much to weigh unprotected risk vs price (default 1)') },
  },
  guard(({ query, weight }: { query: string; weight?: number }) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const groups = listGroups(db).filter((g) => words.every((w) => (g.title + ' ' + g.group_key).toLowerCase().replace(/[^a-z0-9 |]/g, '').includes(w.replace(/[^a-z0-9]/g, ''))));
    // Agents search and answer by the real product name; only the web UI anonymises products.
    const realName = db.prepare(`SELECT m.brand || ' ' || m.model AS t FROM product_models m WHERE m.group_key = ? LIMIT 1`);
    return { matches: groups.slice(0, 5).map((g) => ({ item: (realName.get(g.group_key) as { t: string } | undefined)?.t ?? g.title, ...withRefundRules(rankGroup(db, g.group_key, weight ?? 1)) })), note: 'Ranking uses only price and the expected loss the buyer is not protected against; no fees or ad spend. Store names are anonymised for the hackathon demo. Stakes are hypothetical: real stores have not staked anything.' };
  }),
);

server.registerTool(
  'get_store_ranking',
  {
    title: 'Rank stores for one item',
    description: 'Ranks the stores selling one item (group_key from find_vouched_products) with per-claim P(fail), stake, and expected loss.',
    inputSchema: { group_key: z.string(), weight: z.number().min(0).max(10).optional() },
  },
  guard(({ group_key, weight }: { group_key: string; weight?: number }) => withRefundRules(rankGroup(db, group_key, weight ?? 1))),
);

server.registerTool(
  'buy_with_staked_claims',
  {
    title: 'Buy on PayPal Sandbox with the store’s staked claims',
    description:
      'Creates claim contracts from the store’s standing staked claims (terms frozen and hashed), then pays the real current price on PayPal Sandbox. Claims are judged later on Channel3 data; misses are refunded automatically. Sandbox only: no real money moves.',
    inputSchema: { product_id: z.string().describe('product_id of the chosen store listing (from the ranking)') },
  },
  guard(async ({ product_id }: { product_id: string }) => {
    const claims = standingClaims(db, product_id).map(({ claim_type, stake_usd }) => ({ claim_type, stake_usd }));
    if (claims.length === 0) throw new Error('This store has no staked claims on that item; nothing to contract.');
    const r = await purchase(ctx, { product_id, claims });
    return { purchase_id: r.purchase_id, store: r.store, price: r.price, paypal_order_id: r.order.orderId, paypal_capture_id: r.order.captureId, contracts: r.contracts.map((c) => ({ id: c.id, claim: c.terms.claim_type, max_refund_usd: c.terms.stake_usd, refund_rule: REFUND_RULE[c.terms.claim_type], judged_after: c.terms.judge_after_day, hash: c.hash })), immediate_verdicts: r.judged.results };
  }),
);

server.registerTool(
  'verify_promise',
  {
    title: 'Verify a store’s promise',
    description:
      'Checks the promise a store has registered with Vouch for a listing (the no-price-drop promise: full difference refunded by PayPal), with the hash of its canonical terms. Pass the merchant-signed AP2 checkout_jwt you received to also verify its signature and that the Vouch promise inside it equals the registered terms by hash.',
    inputSchema: { product_id: z.string().describe('product_id of the store listing (from the ranking)'), checkout_jwt: z.string().optional().describe('merchant-signed AP2 checkout the agent received') },
  },
  guard(({ product_id, checkout_jwt }: { product_id: string; checkout_jwt?: string }) => verifyPromise(db, product_id, checkout_jwt)),
);

server.registerTool(
  'get_contract_status',
  {
    title: 'Contract status',
    description: 'Status, verdict, evidence summary, and PayPal refund id for a contract id or purchase id.',
    inputSchema: { id: z.string() },
  },
  guard(({ id }: { id: string }) => {
    const rows = db.prepare(`SELECT c.id, c.run_id AS purchase_id, c.claim_type, c.status, c.hash, c.domain, c.paypal_order_id, json_extract(c.terms_json,'$.judge_after_day') AS judge_after_day,
        j.reason, j.payout_usd, f.paypal_refund_id FROM contracts c LEFT JOIN judgments j ON j.contract_id=c.id LEFT JOIN refunds f ON f.contract_id=c.id AND f.ok=1
        WHERE c.mode='live' AND (c.id = ? OR c.run_id = ?)`).all(id, id) as any[];
    if (rows.length === 0) throw new Error(`No contract or purchase ${id}`);
    return rows.map((r) => ({ ...r, store: storeLabel(r.domain) }));
  }),
);

server.registerTool(
  'get_rules',
  { title: 'Judging rules', description: 'The deterministic rules used to judge every claim type.', inputSchema: {} },
  guard(() => ({ rule_version: RULE_VERSION, claims: CLAIM_LABELS, refund_rules: REFUND_RULE, defaults: DEFAULTS, missing_evidence: 'buyer favour, full stake' })),
);

await server.connect(new StdioServerTransport());
console.error('Vouch MCP server ready on stdio');
