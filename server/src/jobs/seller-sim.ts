// Seller-agent simulation (docs/concept.md §27): one "agent store" for one
// product group sells to simulated buyers on past days D against the other
// stores at their real Channel3 daily prices (which do not react). Five seller
// conditions run independently on the same days and the same buyers:
//   (a) real price on D, no promise
//   (b) real price on D, promise cap = min(10% of price, ceil(expected_drop_usd))
//   (c) rule seller: undercut cheapest other store by $0.01 down to floor;
//       offer cap = min(10% of price, expected_drop_usd) when expected payout
//       is < 25% of gross margin
//   (d) LLM decides the 7-day promise cap once per day (price = real price) and
//       keeps a nightly strategy memo
//   (e) LLM decides daily price and promise cap, answers all 6 of the day's
//       buyer messages in one batched call (personal price/cap within bounds or
//       keep the listing), and updates its nightly strategy memo
// Promises are 7-day no-price-drop claims judged on the condition's own price
// path over D+1..D+7. Nothing is written to the database except LLM usage.
//
// CLI:
//   node src/jobs/seller-sim.ts <group_key or #CODE> [--seed 1] [--mix patient|urgent] [--from 2026-10-07] [--days N] [--conditions a,b,c,d,e] [--store "Demo store XX00"] [--thinking LOW|MEDIUM|HIGH|DEFAULT] [--goal TEXT] [--tag NAME] [--no-memo] [--no-chat] [--floor 0.9] [--ceiling 1.1] [--cap-pct 10]
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from '../config.ts';
import { openDb, recordLlmCalls } from '../db.ts';
import type { Listing } from '../features.ts';
import { groupLabel } from '../labels.ts';
import { extractJson, llmModelId } from '../llm.ts';
import { dropRisk, marketGroups } from '../market.ts';
import { addDays, round2 } from '../rules.ts';
import { storeLabel } from '../score.ts';


type Condition = 'a' | 'b' | 'c' | 'd' | 'e';
type Mix = 'patient' | 'urgent';

const ALL_CONDITIONS: readonly Condition[] = ['a', 'b', 'c', 'd', 'e'];
const WINDOW_DAYS = 7;
const BUYERS_PER_DAY = 6;
const LLM_TEMPERATURE = 0.3;
const HISTORY_LOOKBACK_DAYS = 14;

// ---------- CLI parsing ----------

function parseCli(argv: string[]): {
  target: string;
  seed: number;
  mix: Mix;
  from: string;
  days: number | undefined;
  conditions: Condition[];
  store: string | undefined;
  thinking: 'LOW' | 'MEDIUM' | 'HIGH' | undefined;
  goal: string;
  tag: string | undefined;
  noMemo: boolean;
  noChat: boolean;
  floor: number;
  ceiling: number;
  capPct: number;
  promise: 'full' | 'capped';
} {
  // The owner's safety valves (concept §28): price within floor..ceiling × the day's real price, promise cap ≤ capPct% of the price.
  let floor = 0.9;
  let ceiling = 1.1;
  let capPct = 10;
  // Promise rule (concept §29): full = whole difference refunded (cap = price paid), capped = old cap_usd <= capPct% of price.
  let promise: 'full' | 'capped' = 'full';
  // Ablations (concept §27.6): --no-memo = no nightly strategy memo; --no-chat = no personal offers (listing only).
  let noMemo = false;
  let noChat = false;
  let goal = 'Maximise profit after refunds over the coming weeks.'; // the owner's policy text (--goal)
  let tag: string | undefined;
  let thinking: 'LOW' | 'MEDIUM' | 'HIGH' | undefined = 'LOW'; // LOW is ~2.5x faster than the default (2026-10-30)
  let target: string | undefined;
  let store: string | undefined;
  let seed = 1;
  let mix: Mix = 'patient';
  let from = '2026-10-07';
  let days: number | undefined;
  let conditions: Condition[] = [...ALL_CONDITIONS];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v)) throw new Error(`Invalid --seed: ${argv[i]}`);
      seed = v;
    } else if (arg === '--mix') {
      const v = argv[++i];
      if (v !== 'patient' && v !== 'urgent') throw new Error(`Invalid --mix: ${v} (expected patient|urgent)`);
      mix = v;
    } else if (arg === '--from') {
      const v = argv[++i];
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Invalid --from date: ${v} (expected YYYY-MM-DD)`);
      from = v;
    } else if (arg === '--floor' || arg === '--ceiling' || arg === '--cap-pct') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid ${arg}: ${argv[i]}`);
      if (arg === '--floor') floor = v;
      else if (arg === '--ceiling') ceiling = v;
      else capPct = v;
    } else if (arg === '--promise') {
      const v = argv[++i];
      if (v !== 'full' && v !== 'capped') throw new Error(`Invalid --promise: ${v} (expected full|capped)`);
      promise = v;
    } else if (arg === '--no-memo') {
      noMemo = true;
    } else if (arg === '--no-chat') {
      noChat = true;
    } else if (arg === '--goal') {
      goal = argv[++i];
      if (!goal) throw new Error('Invalid --goal (expected the owner policy text)');
    } else if (arg === '--tag') {
      tag = argv[++i];
      if (!tag || !/^[a-z0-9-]+$/.test(tag)) throw new Error('Invalid --tag (lowercase letters, digits, hyphens)');
    } else if (arg === '--thinking') {
      const v = (argv[++i] ?? '').toUpperCase();
      if (v !== 'LOW' && v !== 'MEDIUM' && v !== 'HIGH' && v !== 'DEFAULT') throw new Error(`Invalid --thinking: ${v} (LOW|MEDIUM|HIGH|DEFAULT)`);
      thinking = v === 'DEFAULT' ? undefined : v;
    } else if (arg === '--store') {
      store = argv[++i];
      if (!store) throw new Error('Invalid --store (expected a demo store label such as "Demo store AB12")');
    } else if (arg === '--days') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error(`Invalid --days: ${argv[i]} (expected positive integer)`);
      days = v;
    } else if (arg === '--conditions') {
      const raw = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (raw.length === 0) throw new Error('Empty --conditions list');
      for (const c of raw) {
        if (!(ALL_CONDITIONS as readonly string[]).includes(c)) {
          throw new Error(`Unknown condition "${c}" in --conditions (expected subset of a,b,c,d,e)`);
        }
      }
      conditions = [...new Set(raw as Condition[])];
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (!target) {
      target = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!target) {
    throw new Error(
      'Usage: node src/jobs/seller-sim.ts <group_key or #CODE> [--seed 1] [--mix patient|urgent] [--from 2026-10-07] [--days N] [--conditions a,b,c,d,e] [--store "Demo store XX00"] [--thinking LOW|MEDIUM|HIGH|DEFAULT] [--goal TEXT] [--tag NAME] [--no-memo] [--no-chat] [--floor 0.9] [--ceiling 1.1] [--cap-pct 10 (capped only; ignored under full)] [--promise full|capped (default full)]',
    );
  }
  return { target, seed, mix, from, days, conditions, store, thinking, goal, tag, noMemo, noChat, floor, ceiling, capPct, promise };
}

const cli = parseCli(process.argv.slice(2));
const db = openDb(config().dbPath);
await recordLlmCalls(db, 'seller-sim');

// ---------- Group & Agent Store selection ----------

const groups = marketGroups(db);
let groupKey: string | undefined;
if (groups.has(cli.target)) {
  groupKey = cli.target;
} else {
  const code = cli.target.startsWith('#') ? cli.target.toUpperCase() : `#${cli.target.toUpperCase()}`;
  for (const [k, ls] of groups.entries()) {
    const lbl = groupLabel(db, k, ls[0].product_id);
    if (lbl.endsWith(`· ${code}`) || lbl === cli.target) {
      groupKey = k;
      break;
    }
  }
}
if (!groupKey) {
  throw new Error(`Unknown product group or #CODE: ${cli.target}`);
}
const groupListings = groups.get(groupKey)!;
const productLabel = groupLabel(db, groupKey, groupListings[0].product_id);

// Contiguous daily coverage starting at `from`.
function contiguousSpanFrom(l: Listing, startDay: string): number {
  let n = 0;
  while (l.series.has(addDays(startDay, n))) n++;
  return n;
}

function meanSeriesPrice(l: Listing, days: string[]): number {
  return days.reduce((s, d) => s + l.series.get(d)!, 0) / days.length;
}

const spans = groupListings.map((l) => ({ l, span: contiguousSpanFrom(l, cli.from) }));
const maxPossibleDays = Math.max(...spans.map((x) => x.span - WINDOW_DAYS));
if (maxPossibleDays < 1) {
  throw new Error(
    `No listing in ${productLabel} (${groupKey}) has contiguous daily prices from ${cli.from} through at least ${addDays(cli.from, WINDOW_DAYS)}`,
  );
}
const nSaleDays = cli.days ?? maxPossibleDays;
const neededSpan = nSaleDays + WINDOW_DAYS;
const allDays = Array.from({ length: neededSpan }, (_, i) => addDays(cli.from, i));
const saleDays = allDays.slice(0, nSaleDays);
const lastSaleDay = saleDays.at(-1)!;
const lastJudgeDay = allDays.at(-1)!;

const eligibleAgentStores = spans
  .filter((x) => x.span >= neededSpan)
  .map((x) => x.l)
  .sort(
    (a, b) =>
      meanSeriesPrice(a, allDays) - meanSeriesPrice(b, allDays) ||
      [...a.series.values()].reduce((s, p) => s + p, 0) / a.series.size -
        [...b.series.values()].reduce((s, p) => s + p, 0) / b.series.size ||
      a.product_id.localeCompare(b.product_id),
  );

if (eligibleAgentStores.length === 0) {
  throw new Error(
    `No listing in ${productLabel} (${groupKey}) has a price on every day from ${cli.from} to ${lastJudgeDay} (${nSaleDays} sale days + ${WINDOW_DAYS} judging days)`,
  );
}

// --store picks the agent store (e.g. one whose real price moved); default: lowest mean price.
const agentListing = cli.store ? eligibleAgentStores.find((l) => storeLabel(l.domain) === cli.store) : eligibleAgentStores[0];
if (!agentListing) throw new Error(`${cli.store} is not a listing of ${productLabel} with prices on every day from ${cli.from} to ${lastJudgeDay}`);
const agentStore = storeLabel(agentListing.domain);
const peerListings = groupListings.filter((l) => l.product_id !== agentListing.product_id);

// ---------- Market snapshot & leak-free risk pre-validation per day ----------

interface StoreDayInfo {
  product_id: string;
  store: string;
  real_price_usd: number;
  p_drop: number;
  expected_drop_usd: number;
  method: string;
}

interface DayMarket {
  day: string;
  is_sale_day: boolean;
  agent: StoreDayInfo;
  others: StoreDayInfo[];
  market_min_usd: number;
  min_store: StoreDayInfo;
  floor_usd: number;
  ceiling_usd: number;
  unit_cost_20_usd: number;
  unit_cost_10_usd: number;
  unit_cost_30_usd: number;
}

const firstDayRealPrice = agentListing.series.get(cli.from)!;

const marketByDay = new Map<string, DayMarket>();
for (let i = 0; i < allDays.length; i++) {
  const day = allDays[i];
  const isSaleDay = i < nSaleDays;
  const agentRealPrice = agentListing.series.get(day);
  if (agentRealPrice === undefined) {
    throw new Error(`Agent store ${agentStore} is missing a real price on ${day}`);
  }
  const agentRisk = dropRisk(db, agentListing.product_id, WINDOW_DAYS, day);
  if (!agentRisk.method.startsWith('as-of')) {
    throw new Error(`dropRisk for ${agentStore} on ${day} returned non-as-of method: "${agentRisk.method}"`);
  }
  const agentInfo: StoreDayInfo = {
    product_id: agentListing.product_id,
    store: agentStore,
    real_price_usd: agentRealPrice,
    p_drop: agentRisk.p_drop,
    expected_drop_usd: agentRisk.expected_drop_usd,
    method: agentRisk.method,
  };

  const others: StoreDayInfo[] = [];
  for (const p of peerListings) {
    const price = p.series.get(day);
    if (price === undefined) continue;
    const r = dropRisk(db, p.product_id, WINDOW_DAYS, day);
    if (!r.method.startsWith('as-of')) {
      throw new Error(`dropRisk for ${storeLabel(p.domain)} on ${day} returned non-as-of method: "${r.method}"`);
    }
    others.push({
      product_id: p.product_id,
      store: storeLabel(p.domain),
      real_price_usd: price,
      p_drop: r.p_drop,
      expected_drop_usd: r.expected_drop_usd,
      method: r.method,
    });
  }
  others.sort((a, b) => a.real_price_usd - b.real_price_usd || a.store.localeCompare(b.store));
  if (others.length < 1) {
    throw new Error(`Fewer than 1 other store has a real price on ${day} for ${productLabel}`);
  }

  const allStoresToday = [agentInfo, ...others].sort(
    (a, b) => a.real_price_usd - b.real_price_usd || a.store.localeCompare(b.store),
  );
  const minStore = allStoresToday[0];

  marketByDay.set(day, {
    day,
    is_sale_day: isSaleDay,
    agent: agentInfo,
    others,
    market_min_usd: minStore.real_price_usd,
    min_store: minStore,
    floor_usd: round2(cli.floor * agentRealPrice), // owner's floor follows the day's real price, so (e) can go as low as the real path
    // The ceiling never falls below its first-day level, so a drop in the real store's price never forces the agent to cut (and pay refunds).
    ceiling_usd: round2(cli.ceiling * Math.max(firstDayRealPrice, agentRealPrice)),
    unit_cost_20_usd: round2(0.8 * agentRealPrice),
    unit_cost_10_usd: round2(0.9 * agentRealPrice),
    unit_cost_30_usd: round2(0.7 * agentRealPrice),
  });
}

// ---------- Seeded PRNG (mulberry32) & deterministic buyer generation ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayPrngSeed(seed: number, day: string): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (const ch of `seller-sim|${seed}|${day}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  return h >>> 0;
}

interface BuyerPersona {
  buyer_id: number;
  budget_usd: number;
  aversion_w: 1 | 5 | 10;
  can_wait: boolean;
  wait_cost_usd: number; // Infinity when !can_wait
  message: string;
}

const URGENT_CLAUSES = [
  'I need to order this today as a gift for this weekend, so I cannot wait for a later sale.',
  'Mine broke and I need a replacement right away—waiting around for future markdowns is not an option.',
  'I have an upcoming trip in a few days and need to buy today rather than hold off.',
  'Ordering for a family event this week, so I have to purchase today.',
] as const;

const PATIENT_LOW_COST_CLAUSES = [
  'I can easily wait for Black Friday or a future promotion if today’s deal isn’t compelling.',
  'I am in no rush at all and happy to hold off and watch prices over the coming weeks.',
  'Just shopping early—I will gladly wait if there is a chance of overpaying today.',
  'No deadline on my end; I can wait for a price drop unless the offer today is well protected.',
] as const;

const PATIENT_MOD_COST_CLAUSES = [
  'I would prefer to buy today so I have it soon, though I can wait a week if the price might drop.',
  'Looking to pick one up soon, but I can hold off if prices look likely to fall.',
  'I’d like to order today if the terms are right, though I can wait a little while for a better deal.',
  'Hoping to buy today, but I am willing to wait if buying now looks risky.',
] as const;

const AVERSION_CLAUSES: Record<1 | 5 | 10, readonly string[]> = {
  1: [
    'Price is all I care about—just give me your best upfront price today.',
    'Today’s sticker price is what matters to me; a small price dip later doesn’t bother me much.',
    'I focus on the checkout price today rather than worrying much about post-purchase price drops.',
    'Mostly looking for the lowest price today; price-drop guarantees are secondary for me.',
  ],
  5: [
    'I mind seeing the price drop right after I buy, so a 7-day price-drop promise or a sharp price would help me decide.',
    'I want a fair price today and some reassurance that I won’t regret buying right before a markdown.',
    'A reasonable price with protection against a near-term price cut would make me comfortable buying now.',
    'I dislike overpaying right before a sale, so a price-drop refund promise carries real weight for me.',
  ],
  10: [
    'I’d hate to see the price drop after I buy—without solid 7-day price-drop protection or a deep discount, I’d rather not risk it.',
    'Nothing frustrates me more than watching the price get cut right after I buy; strong downside protection matters a lot to me.',
    'I am very worried about a price drop over the next week and need a real price-drop refund promise to buy with confidence.',
    'Post-purchase price drops really bother me; I strongly prefer a store that backs its price with an automatic refund promise.',
  ],
};

const BUDGET_TIGHT_CLAUSES = [
  'My budget is tight near the lowest prices on the market today.',
  'I am comparing the cheapest listings closely and cannot stretch much above the market low.',
] as const;

const BUDGET_MOD_CLAUSES = [
  'I have a little room above the cheapest listing if the overall offer and protection make it worthwhile.',
  'I can pay a modest premium over the lowest store if the value or guarantee justifies it.',
] as const;

const BUDGET_FLEX_CLAUSES = [
  'My budget has room for a fair price—I care most about the best risk-adjusted deal.',
  'Budget is flexible within reason as long as the price and protection make sense.',
] as const;

function buildBuyerMessage(
  budgetMult: number,
  w: 1 | 5 | 10,
  canWait: boolean,
  waitMult: number,
  u1: number,
  u2: number,
  u3: number,
): string {
  const urgencyPool = !canWait
    ? URGENT_CLAUSES
    : waitMult < 0.025
      ? PATIENT_LOW_COST_CLAUSES
      : PATIENT_MOD_COST_CLAUSES;
  const c1 = urgencyPool[Math.floor(u1 * urgencyPool.length) % urgencyPool.length];
  const avPool = AVERSION_CLAUSES[w];
  const c2 = avPool[Math.floor(u2 * avPool.length) % avPool.length];
  const bPool = budgetMult < 1.05 ? BUDGET_TIGHT_CLAUSES : budgetMult < 1.1 ? BUDGET_MOD_CLAUSES : BUDGET_FLEX_CLAUSES;
  const c3 = bPool[Math.floor(u3 * bPool.length) % bPool.length];
  return `${c1} ${c2} ${c3}`;
}

function generateBuyersForDay(day: string, mkt: DayMarket, seed: number, mix: Mix): BuyerPersona[] {
  const rng = mulberry32(dayPrngSeed(seed, day));
  const waitProb = mix === 'patient' ? 0.7 : 0.3;
  const buyers: BuyerPersona[] = [];
  for (let i = 0; i < BUYERS_PER_DAY; i++) {
    const uBudget = rng();
    const uAversion = rng();
    const uWait = rng();
    const uWaitCost = rng();
    const u1 = rng();
    const u2 = rng();
    const u3 = rng();

    const budgetMult = 1.0 + 0.15 * uBudget;
    const budget = round2(mkt.market_min_usd * budgetMult);
    const w: 1 | 5 | 10 = uAversion < 0.4 ? 1 : uAversion < 0.8 ? 5 : 10;
    const canWait = uWait < waitProb;
    const waitMult = 0.01 + 0.03 * uWaitCost;
    const waitCost = canWait ? round2(waitMult * mkt.market_min_usd) : Infinity;
    const message = buildBuyerMessage(budgetMult, w, canWait, waitMult, u1, u2, u3);

    buyers.push({
      buyer_id: i + 1,
      budget_usd: budget,
      aversion_w: w,
      can_wait: canWait,
      wait_cost_usd: waitCost,
      message,
    });
  }
  return buyers;
}

const buyersByDay = new Map<string, BuyerPersona[]>();
for (const day of saleDays) {
  buyersByDay.set(day, generateBuyersForDay(day, marketByDay.get(day)!, cli.seed, cli.mix));
}

// ---------- Bounds clamping & deterministic buyer choice ----------

function clampCap(rawCap: number, priceCharged: number): { cap_usd: number; max_cap_usd: number; clamped: boolean } {
  const maxCap = round2((cli.capPct / 100) * priceCharged);
  const rounded = round2(rawCap);
  const cap = round2(Math.min(maxCap, Math.max(0, rounded)));
  return { cap_usd: cap, max_cap_usd: maxCap, clamped: Math.abs(cap - rounded) > 1e-6 };
}

function clampPriceAndCap(
  rawPrice: number,
  rawCap: number,
  mkt: DayMarket,
): { price_usd: number; cap_usd: number; max_cap_usd: number; clamped: boolean } {
  const hi = Math.max(mkt.floor_usd, mkt.ceiling_usd);
  const roundedPrice = round2(rawPrice);
  const price = round2(Math.min(hi, Math.max(mkt.floor_usd, roundedPrice)));
  const c = clampCap(rawCap, price);
  const priceClamped = Math.abs(price - roundedPrice) > 1e-6;
  return { price_usd: price, cap_usd: c.cap_usd, max_cap_usd: c.max_cap_usd, clamped: priceClamped || c.clamped };
}

interface OfferSeen {
  store: string;
  price_usd: number;
  cap_usd: number;
  p_drop: number;
  expected_drop_usd: number;
  effective_cost_usd: number;
  within_budget: boolean;
}

interface BuyerEvaluation {
  buyer_id: number;
  message: string;
  persona: {
    budget_usd: number;
    aversion_w: 1 | 5 | 10;
    can_wait: boolean;
    wait_cost_usd: number | null;
    wait_effective_cost_usd: number | null;
  };
  agent_offer: {
    price_usd: number;
    cap_usd: number;
    personal: boolean;
    clamped: boolean;
    raw_price_usd?: number;
    raw_cap_usd?: number;
    reply?: string;
  };
  offers_seen: OfferSeen[];
  choice: 'agent' | 'other_store' | 'wait';
  chosen_store: string | null;
  price_paid_usd: number | null;
  cap_usd: number | null;
  reason: string;
  seller_feedback_reason: string; // reason shown to the LLM seller on D+1 (no hidden persona numbers)
}

function evaluateBuyer(
  buyer: BuyerPersona,
  mkt: DayMarket,
  agentOffer: {
    price_usd: number;
    cap_usd: number;
    personal: boolean;
    clamped: boolean;
    raw_price_usd?: number;
    raw_cap_usd?: number;
    reply?: string;
  },
): BuyerEvaluation {
  const offerFor = (s: StoreDayInfo, price: number, cap: number): OfferSeen => {
    const unprotected = s.p_drop * Math.max(0, s.expected_drop_usd - cap);
    const cost = round2(price + buyer.aversion_w * unprotected);
    return {
      store: s.store,
      price_usd: price,
      cap_usd: cap,
      p_drop: round2(s.p_drop),
      expected_drop_usd: s.expected_drop_usd,
      effective_cost_usd: cost,
      within_budget: price <= buyer.budget_usd + 1e-9,
    };
  };

  const agentSeen = offerFor(mkt.agent, agentOffer.price_usd, agentOffer.cap_usd);
  const otherSeen = mkt.others.map((o) => offerFor(o, o.real_price_usd, 0));
  const allOffers = [agentSeen, ...otherSeen].sort(
    (a, b) => a.effective_cost_usd - b.effective_cost_usd || a.store.localeCompare(b.store),
  );

  const waitCost = buyer.can_wait
    ? round2(mkt.market_min_usd - mkt.min_store.p_drop * mkt.min_store.expected_drop_usd + buyer.wait_cost_usd)
    : Infinity;

  // Lowest-cost offer (tie-break by store label). Buy if its price <= budget and its cost <= wait cost; otherwise wait.
  const bestOverall = allOffers[0];

  let choice: 'agent' | 'other_store' | 'wait' = 'wait';
  let chosenStore: string | null = null;
  let pricePaid: number | null = null;
  let capChosen: number | null = null;
  let reason: string;
  let sellerReason: string;

  if (bestOverall.within_budget && bestOverall.effective_cost_usd <= waitCost + 1e-9) {
    chosenStore = bestOverall.store;
    pricePaid = bestOverall.price_usd;
    capChosen = bestOverall.cap_usd;
    if (bestOverall.store === mkt.agent.store) {
      choice = 'agent';
      reason = `Bought from ${mkt.agent.store} at $${bestOverall.price_usd.toFixed(2)} (cap $${bestOverall.cap_usd.toFixed(2)}, effective cost $${bestOverall.effective_cost_usd.toFixed(2)} <= wait ${Number.isFinite(waitCost) ? '$' + waitCost.toFixed(2) : '∞'}).`;
      sellerReason = `Bought your offer ($${bestOverall.price_usd.toFixed(2)}, cap $${bestOverall.cap_usd.toFixed(2)}).`;
    } else {
      choice = 'other_store';
      reason = `Bought from ${bestOverall.store} at $${bestOverall.price_usd.toFixed(2)} (effective cost $${bestOverall.effective_cost_usd.toFixed(2)} beat agent $${agentSeen.effective_cost_usd.toFixed(2)}).`;
      // Say what the rival actually offered (other stores never promise) and the public drop
      // estimates the buyer weighed; a bare "higher risk-adjusted cost" made the agent imagine
      // rival guarantees (concept §27.5).
      const rival = mkt.others.find((o) => o.store === bestOverall.store)!;
      sellerReason = `Buyer chose ${bestOverall.store} at $${bestOverall.price_usd.toFixed(2)} with no promise over your offer ($${agentSeen.price_usd.toFixed(2)}, cap $${agentSeen.cap_usd.toFixed(2)}): Vouch estimates a ${(rival.p_drop * 100).toFixed(1)}% chance that ${bestOverall.store}'s price drops within 7 days (vs ${(mkt.agent.p_drop * 100).toFixed(1)}% for yours), so the buyer saw less risk there.`;
    }
  } else {
    choice = 'wait';
    if (!bestOverall.within_budget) {
      reason = `Waited: lowest-cost offer (${bestOverall.store} at $${bestOverall.price_usd.toFixed(2)}, effective cost $${bestOverall.effective_cost_usd.toFixed(2)}) exceeded budget $${buyer.budget_usd.toFixed(2)}.`;
      sellerReason =
        bestOverall.store === mkt.agent.store
          ? `Buyer did not buy: your price ($${agentSeen.price_usd.toFixed(2)}) exceeded the buyer's budget.`
          : `Buyer did not buy: the lowest risk-adjusted offer on the market exceeded the buyer's upfront budget, and your offer ($${agentSeen.price_usd.toFixed(2)}, cap $${agentSeen.cap_usd.toFixed(2)}) had higher effective cost.`;
    } else {
      reason = `Waited: lowest effective cost ($${bestOverall.effective_cost_usd.toFixed(2)} at ${bestOverall.store}; agent $${agentSeen.effective_cost_usd.toFixed(2)}) exceeded wait cost $${waitCost.toFixed(2)}.`;
      sellerReason = `Buyer chose to wait rather than buy today: your offer ($${agentSeen.price_usd.toFixed(2)}, cap $${agentSeen.cap_usd.toFixed(2)}) left too much unprotected price-drop risk or too high a price compared with waiting.`;
    }
  }

  return {
    buyer_id: buyer.buyer_id,
    message: buyer.message,
    persona: {
      budget_usd: buyer.budget_usd,
      aversion_w: buyer.aversion_w,
      can_wait: buyer.can_wait,
      wait_cost_usd: Number.isFinite(buyer.wait_cost_usd) ? buyer.wait_cost_usd : null,
      wait_effective_cost_usd: Number.isFinite(waitCost) ? waitCost : null,
    },
    agent_offer: agentOffer,
    offers_seen: allOffers,
    choice,
    chosen_store: chosenStore,
    price_paid_usd: pricePaid,
    cap_usd: capChosen,
    reason,
    seller_feedback_reason: sellerReason,
  };
}

// ---------- LLM schemas & prompts for conditions (d) and (e) ----------

const CapOnlySchema = z.object({
  cap_usd: z.number(),
  reasoning: z.string(),
});

const PriceAndCapSchema = z.object({
  price_usd: z.number(),
  cap_usd: z.number(),
  reasoning: z.string(),
});

const PromiseOnlySchema = z.object({
  promise: z.boolean(),
  reasoning: z.string(),
});

const PriceAndPromiseSchema = z.object({
  price_usd: z.number(),
  promise: z.boolean(),
  reasoning: z.string(),
});

const BatchBuyerOffersSchema = z.object({
  offers: z
    .array(
      z.object({
        buyer_id: z.number(),
        keep_listing: z.boolean(),
        price_usd: z.number(),
        cap_usd: z.number(),
        reply: z.string(),
      }),
    )
    .length(BUYERS_PER_DAY),
});

const BatchBuyerOffersFullSchema = z.object({
  offers: z
    .array(
      z.object({
        buyer_id: z.number(),
        keep_listing: z.boolean(),
        price_usd: z.number(),
        promise: z.boolean(),
        reply: z.string(),
      }),
    )
    .length(BUYERS_PER_DAY),
});

const MemoSchema = z.object({
  memo: z.string(),
});

const SYSTEM_D_DAILY_CAPPED = `You are the autonomous store manager agent for an online retail store selling a consumer product.
Today your store's selling price is fixed at the listed price given in the prompt. You decide ONLY the 7-day no-price-drop promise cap (cap_usd) for today's listing.
Promise rule: if your store's daily price on any of the next 7 days (D+1..D+7) falls below the price paid today, the buyer automatically receives a PayPal refund of (price_paid - min_later_price) up to cap_usd.
Bounds enforced: 0 <= cap_usd <= ${cli.capPct}% of today's price.
Goal: follow the owner's policy (owner_policy.goal). Profit per sale = price_paid - unit_cost - refund_paid.
Return JSON: {"cap_usd": <number>, "reasoning": "<1-2 concise sentences>"}.`;

const SYSTEM_E_DAILY_CAPPED = `You are the autonomous store manager agent for an online retail store selling a consumer product.
Each morning you set today's public listing: your daily price (price_usd) and your 7-day no-price-drop promise cap (cap_usd).
Promise rule (Most-Favored-Customer): if your store's lowest price on any of the next 7 days (D+1..D+7)—whether public listed price OR a personal price at which a sale closes—falls below the price a buyer paid, that buyer automatically receives a PayPal refund of (price_paid - min_later_price) up to their cap_usd.
Note: cutting your price (publicly or in a personal sale) triggers automatic PayPal refunds on promised sales from the prior 7 days whose sale price was higher.
Bounds enforced: floor_usd <= price_usd <= ceiling_usd, and 0 <= cap_usd <= ${cli.capPct}% of price_usd.
Goal: follow the owner's policy (owner_policy.goal). Profit per sale = price_paid - unit_cost - refund_paid.
Return JSON: {"price_usd": <number>, "cap_usd": <number>, "reasoning": "<1-2 concise sentences>"}.`;

const SYSTEM_E_BATCH_CAPPED = `You are the autonomous store manager agent answering today's incoming buyer inquiries in one batch.
Each buyer sends a short message describing their situation; infer from their words what might win their order. A buyer may also buy from another store or wait.
Most-Favored-Customer rule: promises from prior days (active_promised_sales_from_prior_7d) are judged over D+1..D+7 against your store's lowest price on each day (the minimum of today's listed price and any personal sale price).
For each buyer_id (1..6), either set keep_listing=true (uses today's listed price and cap) or set keep_listing=false with a personal price_usd (between floor_usd and today's listed price) and cap_usd (between today's listed cap and ${cli.capPct}% of price_usd). A personal offer may only be better for the buyer than the public listing: never a higher price, never a smaller promise.
Return JSON: {"offers": [{"buyer_id": 1, "keep_listing": <boolean>, "price_usd": <number>, "cap_usd": <number>, "reply": "<one short sentence>"}, ...]} with all 6 buyers in order.`;

const SYSTEM_D_DAILY_FULL = `You are the autonomous store manager agent for an online retail store selling a consumer product.
Today your store's selling price is fixed at the listed price given in the prompt. You decide ONLY whether today's listing carries the no-price-drop promise (promise: true|false).
Promise rule (full difference, no cap): if your store's lowest price on any of the next 7 days (D+1..D+7) falls below the price paid today, the buyer automatically receives a PayPal refund of the whole difference (price_paid - min_later_price).
Goal: follow the owner's policy (owner_policy.goal). Profit per sale = price_paid - unit_cost - refund_paid.
Return JSON: {"promise": <boolean>, "reasoning": "<1-2 concise sentences>"}.`;

const SYSTEM_E_DAILY_FULL = `You are the autonomous store manager agent for an online retail store selling a consumer product.
Each morning you set today's public listing: your daily price (price_usd) and whether the listing carries the no-price-drop promise (promise: true|false).
Promise rule (Most-Favored-Customer, full difference, no cap): if your store's lowest price on any of the next 7 days (D+1..D+7)—whether public listed price OR a personal price at which a sale closes—falls below the price a buyer paid, that buyer automatically receives a PayPal refund of the whole difference (price_paid - min_later_price).
Note: cutting your price (publicly or in a personal sale) triggers automatic PayPal refunds on promised sales from the prior 7 days whose sale price was higher.
Bounds enforced: floor_usd <= price_usd <= ceiling_usd.
Goal: follow the owner's policy (owner_policy.goal). Profit per sale = price_paid - unit_cost - refund_paid.
Return JSON: {"price_usd": <number>, "promise": <boolean>, "reasoning": "<1-2 concise sentences>"}.`;

const SYSTEM_E_BATCH_FULL = `You are the autonomous store manager agent answering today's incoming buyer inquiries in one batch.
Each buyer sends a short message describing their situation; infer from their words what might win their order. A buyer may also buy from another store or wait.
Most-Favored-Customer rule (full difference, no cap): promises from prior days (active_promised_sales_from_prior_7d) are judged over D+1..D+7 against your store's lowest price on each day (the minimum of today's listed price and any personal sale price); the whole difference is refunded.
For each buyer_id (1..6), either set keep_listing=true (uses today's listed price and promise) or set keep_listing=false with a personal price_usd (between floor_usd and today's listed price) and promise (true|false). A personal offer may only be better for the buyer than the public listing: never a higher price, never removing a promise the listing has (it may add one).
Return JSON: {"offers": [{"buyer_id": 1, "keep_listing": <boolean>, "price_usd": <number>, "promise": <boolean>, "reply": "<one short sentence>"}, ...]} with all 6 buyers in order.`;

const FULL_PROMISE = cli.promise === 'full';
const SYSTEM_D_DAILY = FULL_PROMISE ? SYSTEM_D_DAILY_FULL : SYSTEM_D_DAILY_CAPPED;
const SYSTEM_E_DAILY = FULL_PROMISE ? SYSTEM_E_DAILY_FULL : SYSTEM_E_DAILY_CAPPED;
const SYSTEM_E_BATCH = FULL_PROMISE ? SYSTEM_E_BATCH_FULL : SYSTEM_E_BATCH_CAPPED;

const SYSTEM_MEMO = `You are the store manager agent writing your nightly strategy memo (at most 500 characters) after reviewing today's sales, lost buyers, and any refunds that became known today.
Rules for the memo:
- Write GENERAL lessons only: how different buyer requests react to price vs. a 7-day promise, when a promise pays off vs. costs too much, and how to price against competitors.
- Do NOT include any dates, store names, or specific dollar prices/numbers.
- Keep it under 500 characters.
Return JSON: {"memo": "<general strategy memo, <= 500 chars>"}.`;

// History up to and including day D (last 14 days, strictly no future leak).
function priceHistoryUpTo(l: Listing, day: string): { day: string; price_usd: number }[] {
  const earliest = addDays(day, -(HISTORY_LOOKBACK_DAYS - 1));
  return [...l.series.entries()]
    .filter(([d]) => d >= earliest && d <= day)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, p]) => ({ day: d, price_usd: p }));
}

// ---------- Per-condition simulation loop ----------

interface SaleRecord {
  sale_id: string;
  sale_day: string;
  buyer_id: number;
  price_paid_usd: number;
  cap_usd: number;
  unit_cost_20_usd: number;
  unit_cost_10_usd: number;
  unit_cost_30_usd: number;
  refund_accrued_so_far_usd: number;
  final_refund_usd: number;
  first_drop_day: string | null;
  min_later_price_usd: number | null;
  min_later_day: string | null;
}

interface RefundKnownEvent {
  sale_id: string;
  sale_day: string;
  buyer_id: number;
  known_on_day: string;
  price_on_day_usd: number;
  sale_price_usd: number;
  cap_usd: number;
  refund_delta_usd: number;
  cumulative_refund_for_sale_usd: number;
}

interface DayRecord {
  day: string;
  is_sale_day: boolean;
  real_price_usd: number;
  unit_cost_usd: number;
  floor_usd: number;
  ceiling_usd: number;
  market_min_real_usd: number;
  other_stores_today: { store: string; real_price_usd: number; p_drop: number; expected_drop_usd: number }[];
  agent_risk_7d: { p_drop: number; expected_drop_usd: number; method: string };
  price: number;
  cap: number;
  listed_price_usd: number;
  listed_cap_usd: number;
  effective_min_price_usd: number;
  listing_clamped: boolean;
  raw_listed_price_usd?: number;
  raw_listed_cap_usd?: number;
  listing_reasoning?: string;
  buyers: BuyerEvaluation[];
  sales: { buyer_id: number; price_paid_usd: number; cap_usd: number }[];
  sales_count: number;
  revenue_usd: number;
  refunds_known: RefundKnownEvent[];
  refunds_known_today: RefundKnownEvent[];
  refunds_known_today_usd: number;
  memo: string | null;
  memo_after_day: string | null;
}

function buildOwnerPolicy(cond: Condition, mkt: DayMarket): Record<string, unknown> {
  const maxCapAtReal = round2((cli.capPct / 100) * mkt.agent.real_price_usd);
  return {
    goal: cli.goal,
    unit_cost_today_usd: mkt.unit_cost_20_usd,
    profit_formula: 'profit_per_sale = price_paid_usd - unit_cost_today_usd - refund_paid_usd',
    price_bounds:
      cond === 'd'
        ? { fixed_price_usd: mkt.agent.real_price_usd, note: 'Price is fixed to today’s real price in condition (d).' }
        : {
            floor_usd: mkt.floor_usd,
            ceiling_today_usd: mkt.ceiling_usd,
            reference_real_price_today_usd: mkt.agent.real_price_usd,
          },
    promise_rules: FULL_PROMISE
      ? {
          claim: 'No price drop for 7 days — Most-Favored-Customer, full difference (judged on the lowest price this store lists OR sells at on D+1..D+7)',
          settlement:
            'If this store’s lowest price (public listed price or any personal sale price) on D+1..D+7 is below the price paid on D, the whole difference (price_paid - min_price) is refunded automatically through PayPal. There is no cap.',
        }
      : {
      claim: 'No price drop for 7 days — Most-Favored-Customer (judged on the lowest price this store lists OR sells at on D+1..D+7)',
      settlement:
        'If this store’s lowest price (public listed price or any personal sale price) on D+1..D+7 is below the price paid on D, the difference (price_paid - min_price) is refunded automatically through PayPal, up to cap_usd.',
      cap_bounds:
        cond === 'd'
          ? { min_cap_usd: 0, max_cap_usd: maxCapAtReal }
          : { min_cap_usd: 0, max_cap_rule: `${cli.capPct}% of the price charged (rounded to cents)` },
        },
  };
}

async function runCondition(cond: Condition) {
  const sales: SaleRecord[] = [];
  const dayRecords: DayRecord[] = [];
  let memo = '';

  for (const day of allDays) {
    const mkt = marketByDay.get(day)!;
    const isSaleDay = mkt.is_sale_day;
    const prevDayRecord = dayRecords.at(-1) ?? null;

    // Yesterday's summary (only what was known by the end of yesterday).
    const yesterdaySummary = prevDayRecord
      ? {
          day: prevDayRecord.day,
          listed_price_usd: prevDayRecord.listed_price_usd,
          listed_cap_usd: prevDayRecord.listed_cap_usd,
          sales_count: prevDayRecord.sales_count,
          revenue_usd: prevDayRecord.revenue_usd,
          sales: prevDayRecord.buyers
            .filter((b) => b.choice === 'agent')
            .map((b) => ({
              buyer_id: b.buyer_id,
              message: b.message,
              price_paid_usd: b.price_paid_usd,
              cap_usd: b.cap_usd,
            })),
          lost_buyers: prevDayRecord.buyers
            .filter((b) => b.choice !== 'agent')
            .map((b) => ({
              buyer_id: b.buyer_id,
              message: b.message,
              your_offer: { price_usd: b.agent_offer.price_usd, cap_usd: b.agent_offer.cap_usd },
              outcome: b.choice,
              reason: b.seller_feedback_reason,
            })),
          refunds_known_yesterday_usd: prevDayRecord.refunds_known_today_usd,
          refunds_known_yesterday: prevDayRecord.refunds_known_today,
        }
      : null;

    // Active promised sales from the prior 7 days (D-7 <= sale_day < D), known on morning of D.
    const activePromisedSales = sales
      .filter((s) => s.cap_usd > 0 && s.sale_day >= addDays(day, -WINDOW_DAYS) && s.sale_day < day)
      .map((s) => ({
        sale_day: s.sale_day,
        price_paid_usd: s.price_paid_usd,
        cap_usd: s.cap_usd,
        refund_already_triggered_usd: s.refund_accrued_so_far_usd,
        remaining_cap_exposure_usd: round2(s.cap_usd - s.refund_accrued_so_far_usd),
      }));

    // 1. Decide today's daily price and promise cap.
    let listedPrice = mkt.agent.real_price_usd;
    let listedCap = 0;
    let listingClamped = false;
    let rawListedPrice: number | undefined;
    let rawListedCap: number | undefined;
    let listingReasoning: string | undefined;

    if (cond === 'a') {
      listedPrice = mkt.agent.real_price_usd;
      listedCap = 0;
    } else if (cond === 'b') {
      listedPrice = mkt.agent.real_price_usd;
      listedCap = isSaleDay
        ? FULL_PROMISE
          ? listedPrice
          : round2(Math.min(round2(0.1 * listedPrice), Math.ceil(mkt.agent.expected_drop_usd)))
        : 0;
    } else if (cond === 'c') {
      const cheapestOther = Math.min(...mkt.others.map((o) => o.real_price_usd));
      listedPrice =
        mkt.agent.real_price_usd > cheapestOther
          ? round2(Math.max(mkt.floor_usd, round2(cheapestOther - 0.01)))
          : mkt.agent.real_price_usd;
      if (isSaleDay) {
        const candCap = FULL_PROMISE ? listedPrice : round2(Math.min(round2(0.1 * listedPrice), mkt.agent.expected_drop_usd));
        const expectedPayout = mkt.agent.p_drop * (FULL_PROMISE ? mkt.agent.expected_drop_usd : Math.min(candCap, mkt.agent.expected_drop_usd));
        const grossMargin = listedPrice - mkt.unit_cost_20_usd;
        listedCap = candCap > 0 && expectedPayout < 0.25 * grossMargin ? candCap : 0;
      } else {
        listedCap = 0;
      }
    } else if (cond === 'd') {
      listedPrice = mkt.agent.real_price_usd;
      if (isSaleDay) {
        const promptData = {
          today: day,
          product: productLabel,
          your_store: agentStore,
          owner_policy: buildOwnerPolicy('d', mkt),
          your_price_today_usd: listedPrice,
          your_7d_drop_risk: {
            p_drop: round2(mkt.agent.p_drop),
            expected_drop_if_it_drops_usd: mkt.agent.expected_drop_usd,
          },
          other_stores_today: mkt.others.map((o) => ({
            store: o.store,
            price_usd: o.real_price_usd,
            p_drop_7d: round2(o.p_drop),
            expected_drop_7d_usd: o.expected_drop_usd,
          })),
          price_histories_last_14d: {
            your_store_real_prices: priceHistoryUpTo(agentListing!, day),
            other_stores: peerListings
              .filter((p) => p.series.has(day))
              .map((p) => ({ store: storeLabel(p.domain), history: priceHistoryUpTo(p, day) })),
          },
          yesterday_results: yesterdaySummary,
          strategy_memo: memo || '(empty — first day)',
        };
        if (FULL_PROMISE) {
          const out = await extractJson(PromiseOnlySchema, {
            system: SYSTEM_D_DAILY,
            prompt: JSON.stringify(promptData),
            temperature: LLM_TEMPERATURE,
            ...(cli.thinking ? { thinking: cli.thinking } : {}),
          });
          listedCap = out.promise ? listedPrice : 0;
          listingReasoning = out.reasoning;
        } else {
          const out = await extractJson(CapOnlySchema, {
            system: SYSTEM_D_DAILY,
            prompt: JSON.stringify(promptData),
            temperature: LLM_TEMPERATURE,
            ...(cli.thinking ? { thinking: cli.thinking } : {}),
          });
          rawListedCap = out.cap_usd;
          const c = clampCap(out.cap_usd, listedPrice);
          listedCap = c.cap_usd;
          listingClamped = c.clamped;
          listingReasoning = out.reasoning;
        }
      } else {
        // For (d), price path on tail days is the real price and there are no buyers.
        listedCap = 0;
      }
    } else if (cond === 'e') {
      const promptData = {
        today: day,
        // Tail days look the same to the agent: telling it the game has ended would let it
        // hold prices to dodge refunds, which the real-price conditions cannot do.
        note: 'Set today’s public listing price and 7-day promise cap before buyer messages arrive.',
        product: productLabel,
        your_store: agentStore,
        owner_policy: buildOwnerPolicy('e', mkt),
        your_7d_drop_risk: {
          p_drop: round2(mkt.agent.p_drop),
          expected_drop_if_it_drops_usd: mkt.agent.expected_drop_usd,
        },
        active_promised_sales_from_prior_7d: activePromisedSales,
        other_stores_today: mkt.others.map((o) => ({
          store: o.store,
          price_usd: o.real_price_usd,
          p_drop_7d: round2(o.p_drop),
          expected_drop_7d_usd: o.expected_drop_usd,
        })),
        price_histories_last_14d: {
          your_store_real_prices: priceHistoryUpTo(agentListing!, day),
          your_store_chosen_prices_so_far: dayRecords.slice(-HISTORY_LOOKBACK_DAYS).map((r) => ({
            day: r.day,
            listed_price_usd: r.listed_price_usd,
            listed_cap_usd: r.listed_cap_usd,
          })),
          other_stores: peerListings
            .filter((p) => p.series.has(day))
            .map((p) => ({ store: storeLabel(p.domain), history: priceHistoryUpTo(p, day) })),
        },
        yesterday_results: yesterdaySummary,
        strategy_memo: memo || '(empty — first day)',
      };
      if (FULL_PROMISE) {
        const out = await extractJson(PriceAndPromiseSchema, {
          system: SYSTEM_E_DAILY,
          prompt: JSON.stringify(promptData),
          temperature: LLM_TEMPERATURE,
          ...(cli.thinking ? { thinking: cli.thinking } : {}),
        });
        rawListedPrice = out.price_usd;
        const clamped = clampPriceAndCap(out.price_usd, 0, mkt);
        listedPrice = clamped.price_usd;
        listedCap = isSaleDay && out.promise ? listedPrice : 0; // full difference: cap = price paid
        listingClamped = clamped.clamped;
        listingReasoning = out.reasoning;
      } else {
        const out = await extractJson(PriceAndCapSchema, {
          system: SYSTEM_E_DAILY,
          prompt: JSON.stringify(promptData),
          temperature: LLM_TEMPERATURE,
          ...(cli.thinking ? { thinking: cli.thinking } : {}),
        });
        rawListedPrice = out.price_usd;
        rawListedCap = out.cap_usd;
        const clamped = clampPriceAndCap(out.price_usd, isSaleDay ? out.cap_usd : 0, mkt);
        listedPrice = clamped.price_usd;
        listedCap = isSaleDay ? clamped.cap_usd : 0;
        listingClamped = clamped.clamped;
        listingReasoning = out.reasoning;
      }
    }

    // 2. On sale days, run buyer interactions and evaluate deterministic buyer choices.
    const buyerEvaluations: BuyerEvaluation[] = [];
    if (isSaleDay) {
      const buyers = buyersByDay.get(day)!;
      let personalOffersByBuyerId: Map<
        number,
        {
          price_usd: number;
          cap_usd: number;
          personal: boolean;
          clamped: boolean;
          raw_price_usd?: number;
          raw_cap_usd?: number;
          reply?: string;
        }
      > | null = null;

      if (cond === 'e' && !cli.noChat) {
        const batchPrompt = {
          today: day,
          product: productLabel,
          your_store: agentStore,
          owner_policy: buildOwnerPolicy('e', mkt),
          your_public_listing_today: {
            listed_price_usd: listedPrice,
            listed_cap_usd: listedCap,
          },
          your_7d_drop_risk: {
            p_drop: round2(mkt.agent.p_drop),
            expected_drop_if_it_drops_usd: mkt.agent.expected_drop_usd,
          },
          other_stores_today: mkt.others.map((o) => ({
            store: o.store,
            price_usd: o.real_price_usd,
            p_drop_7d: round2(o.p_drop),
            expected_drop_7d_usd: o.expected_drop_usd,
          })),
          active_promised_sales_from_prior_7d: activePromisedSales,
          strategy_memo: memo || '(empty — first day)',
          buyers: buyers.map((b) => ({ buyer_id: b.buyer_id, message: b.message })),
        };
        const batchRaw = FULL_PROMISE
          ? await extractJson(BatchBuyerOffersFullSchema, {
              system: SYSTEM_E_BATCH,
              prompt: JSON.stringify(batchPrompt),
              temperature: LLM_TEMPERATURE,
              ...(cli.thinking ? { thinking: cli.thinking } : {}),
            })
          : await extractJson(BatchBuyerOffersSchema, {
              system: SYSTEM_E_BATCH,
              prompt: JSON.stringify(batchPrompt),
              temperature: LLM_TEMPERATURE,
              ...(cli.thinking ? { thinking: cli.thinking } : {}),
            });
        const batchOut = batchRaw as { offers: { buyer_id: number; keep_listing: boolean; price_usd: number; cap_usd?: number; promise?: boolean; reply: string }[] };
        personalOffersByBuyerId = new Map();
        for (const b of buyers) {
          const item = batchOut.offers.find((o) => o.buyer_id === b.buyer_id);
          if (!item) {
            throw new Error(`LLM batch response on ${day} omitted buyer_id ${b.buyer_id}`);
          }
          if (item.keep_listing) {
            personalOffersByBuyerId.set(b.buyer_id, {
              price_usd: listedPrice,
              cap_usd: listedCap,
              personal: false,
              clamped: false,
              reply: item.reply,
            });
          } else {
            // Fairness (concept §28): a personal offer can only beat the public listing for the buyer.
            const fair = clampPriceAndCap(Math.min(item.price_usd, listedPrice), FULL_PROMISE ? 0 : item.cap_usd!, mkt);
            // Full difference: the personal offer carries the promise if the listing has one or the LLM adds one (cap = its price).
            const capFair = FULL_PROMISE
              ? item.promise || listedCap > 0 ? fair.price_usd : 0
              : Math.max(fair.cap_usd, Math.min(listedCap, fair.max_cap_usd));
            const c = { ...fair, cap_usd: capFair, clamped: fair.clamped || item.price_usd > listedPrice + 1e-6 || (!FULL_PROMISE && capFair > fair.cap_usd + 1e-6) };
            const isDifferentFromListing =
              Math.abs(c.price_usd - listedPrice) > 1e-6 || Math.abs(c.cap_usd - listedCap) > 1e-6;
            personalOffersByBuyerId.set(b.buyer_id, {
              price_usd: c.price_usd,
              cap_usd: c.cap_usd,
              personal: isDifferentFromListing,
              clamped: c.clamped,
              ...(c.clamped ? { raw_price_usd: item.price_usd, ...(item.cap_usd !== undefined ? { raw_cap_usd: item.cap_usd } : {}) } : {}),
              reply: item.reply,
            });
          }
        }
      }

      for (const b of buyers) {
        const offer =
          personalOffersByBuyerId?.get(b.buyer_id) ?? {
            price_usd: listedPrice,
            cap_usd: listedCap,
            personal: false,
            clamped: listingClamped,
          };
        const ev = evaluateBuyer(b, mkt, offer);
        buyerEvaluations.push(ev);
        if (ev.choice === 'agent') {
          sales.push({
            sale_id: `${cond}-${day}-b${b.buyer_id}`,
            sale_day: day,
            buyer_id: b.buyer_id,
            price_paid_usd: ev.price_paid_usd!,
            cap_usd: ev.cap_usd!,
            unit_cost_20_usd: mkt.unit_cost_20_usd,
            unit_cost_10_usd: mkt.unit_cost_10_usd,
            unit_cost_30_usd: mkt.unit_cost_30_usd,
            refund_accrued_so_far_usd: 0,
            final_refund_usd: 0,
            first_drop_day: null,
            min_later_price_usd: null,
            min_later_day: null,
          });
        }
      }
    }

    const todaySales = buyerEvaluations.filter((b) => b.choice === 'agent');
    const revenueToday = round2(todaySales.reduce((s, b) => s + (b.price_paid_usd ?? 0), 0));

    // 3. Most-Favored-Customer refund check (concept §28.4):
    // Judge active promised sales from prior days [day - 7 .. day - 1] against the
    // lowest price this store actually listed OR sold at on `day` (D+1..D+7).
    const effectiveMinPriceToday = Math.min(listedPrice, ...todaySales.map((b) => b.price_paid_usd!));
    const refundsKnownToday: RefundKnownEvent[] = [];
    for (const s of sales) {
      if (s.cap_usd <= 0) continue;
      if (day <= s.sale_day || day > addDays(s.sale_day, WINDOW_DAYS)) continue;
      if (s.min_later_price_usd === null || effectiveMinPriceToday < s.min_later_price_usd) {
        s.min_later_price_usd = effectiveMinPriceToday;
        s.min_later_day = day;
      }
      if (effectiveMinPriceToday < s.price_paid_usd - 1e-9) {
        if (s.first_drop_day === null) s.first_drop_day = day;
        const newTotalRefund = round2(Math.min(s.cap_usd, s.price_paid_usd - s.min_later_price_usd));
        const delta = round2(newTotalRefund - s.refund_accrued_so_far_usd);
        if (delta > 0) {
          s.refund_accrued_so_far_usd = newTotalRefund;
          s.final_refund_usd = newTotalRefund;
          refundsKnownToday.push({
            sale_id: s.sale_id,
            sale_day: s.sale_day,
            buyer_id: s.buyer_id,
            known_on_day: day,
            price_on_day_usd: effectiveMinPriceToday,
            sale_price_usd: s.price_paid_usd,
            cap_usd: s.cap_usd,
            refund_delta_usd: delta,
            cumulative_refund_for_sale_usd: newTotalRefund,
          });
        }
      }
    }
    const refundsKnownTodayUsd = round2(refundsKnownToday.reduce((sum, r) => sum + r.refund_delta_usd, 0));

    // 4. Nightly strategy memo rewrite for (d) and (e) on sale days.
    if (isSaleDay && (cond === 'd' || cond === 'e') && !cli.noMemo) {
      const memoPrompt = {
        owner_goal: cli.goal,
        previous_memo: memo || '(empty)',
        today_summary: {
          sales_won: todaySales.length,
          buyers_total: BUYERS_PER_DAY,
          gross_margin_before_future_refunds_usd: round2(
            todaySales.reduce((s, b) => s + ((b.price_paid_usd ?? 0) - mkt.unit_cost_20_usd), 0),
          ),
          buyer_outcomes: buyerEvaluations.map((b) => ({
            buyer_message: b.message,
            your_offer_had_promise: b.agent_offer.cap_usd > 0,
            personal_offer_used: b.agent_offer.personal,
            outcome: b.choice,
            reason: b.seller_feedback_reason,
          })),
          refunds_triggered_today_count: refundsKnownToday.length,
          refunds_triggered_today_usd: refundsKnownTodayUsd,
        },
      };
      const memoOut = await extractJson(MemoSchema, {
        system: SYSTEM_MEMO,
        prompt: JSON.stringify(memoPrompt),
        temperature: LLM_TEMPERATURE,
        ...(cli.thinking ? { thinking: cli.thinking } : {}),
      });
      memo = memoOut.memo.trim().slice(0, 600);
    }

    const dayRec: DayRecord = {
      day,
      is_sale_day: isSaleDay,
      real_price_usd: mkt.agent.real_price_usd,
      unit_cost_usd: mkt.unit_cost_20_usd,
      floor_usd: mkt.floor_usd,
      ceiling_usd: mkt.ceiling_usd,
      market_min_real_usd: mkt.market_min_usd,
      other_stores_today: mkt.others.map((o) => ({
        store: o.store,
        real_price_usd: o.real_price_usd,
        p_drop: round2(o.p_drop),
        expected_drop_usd: o.expected_drop_usd,
      })),
      agent_risk_7d: {
        p_drop: round2(mkt.agent.p_drop),
        expected_drop_usd: mkt.agent.expected_drop_usd,
        method: mkt.agent.method,
      },
      price: listedPrice,
      cap: listedCap,
      listed_price_usd: listedPrice,
      listed_cap_usd: listedCap,
      effective_min_price_usd: effectiveMinPriceToday,
      listing_clamped: listingClamped,
      ...(listingClamped
        ? {
            ...(rawListedPrice !== undefined ? { raw_listed_price_usd: rawListedPrice } : {}),
            ...(rawListedCap !== undefined ? { raw_listed_cap_usd: rawListedCap } : {}),
          }
        : {}),
      ...(listingReasoning ? { listing_reasoning: listingReasoning } : {}),
      buyers: buyerEvaluations,
      sales: todaySales.map((b) => ({
        buyer_id: b.buyer_id,
        price_paid_usd: b.price_paid_usd!,
        cap_usd: b.cap_usd!,
      })),
      sales_count: todaySales.length,
      revenue_usd: revenueToday,
      refunds_known: refundsKnownToday,
      refunds_known_today: refundsKnownToday,
      refunds_known_today_usd: refundsKnownTodayUsd,
      memo: cond === 'd' || cond === 'e' ? memo : null,
      memo_after_day: cond === 'd' || cond === 'e' ? memo : null,
    };
    dayRecords.push(dayRec);

    if (isSaleDay) {
      console.log(
        `[${cond}] ${day} | list $${listedPrice.toFixed(2)} cap $${listedCap.toFixed(2)} | sales ${todaySales.length}/${BUYERS_PER_DAY} rev $${revenueToday.toFixed(2)} | known refunds $${refundsKnownTodayUsd.toFixed(2)}`,
      );
    }
  }

  // Final totals across all sales in this condition.
  const totalSales = sales.length;
  const totalRevenue = round2(sales.reduce((s, x) => s + x.price_paid_usd, 0));
  const totalRefunds = round2(sales.reduce((s, x) => s + x.final_refund_usd, 0));
  const refundedSalesCount = sales.filter((x) => x.final_refund_usd > 0).length;
  const profit20 = round2(sales.reduce((s, x) => s + (x.price_paid_usd - x.unit_cost_20_usd - x.final_refund_usd), 0));
  const profit10 = round2(sales.reduce((s, x) => s + (x.price_paid_usd - x.unit_cost_10_usd - x.final_refund_usd), 0));
  const profit30 = round2(sales.reduce((s, x) => s + (x.price_paid_usd - x.unit_cost_30_usd - x.final_refund_usd), 0));
  const listingClampsCount = dayRecords.filter((d) => d.listing_clamped).length;
  const buyerOfferClampsCount = dayRecords.reduce(
    (s, d) => s + d.buyers.filter((b) => b.agent_offer.clamped).length,
    0,
  );

  return {
    condition: cond,
    totals: {
      sales: totalSales,
      buyers_total: nSaleDays * BUYERS_PER_DAY,
      conversion_rate: round2(totalSales / (nSaleDays * BUYERS_PER_DAY)),
      revenue_usd: totalRevenue,
      refunds_usd: totalRefunds,
      refunded_sales: refundedSalesCount,
      profit_usd: profit20,
      profit_at_10pct_margin_usd: profit10,
      profit_at_20pct_margin_usd: profit20,
      profit_at_30pct_margin_usd: profit30,
      profit_by_margin_usd: {
        margin_10pct: profit10,
        margin_20pct: profit20,
        margin_30pct: profit30,
      },
      clamped_listings: listingClampsCount,
      clamped_buyer_offers: buyerOfferClampsCount,
    },
    sales,
    days: dayRecords,
  };
}

const conditionResults: Record<string, Awaited<ReturnType<typeof runCondition>>> = {};
for (const cond of cli.conditions) {
  conditionResults[cond] = await runCondition(cond);
}

// ---------- Output JSON & compact stdout summary table ----------

const otherStoreLabels = [...new Set(peerListings.map((p) => storeLabel(p.domain)))].sort();

const output = {
  model: llmModelId(),
  run_at: new Date().toISOString(),
  product_label: productLabel,
  agent_store: agentStore,
  other_stores: otherStoreLabels,
  design: {
    seed: cli.seed,
    mix: cli.mix,
    from_day: cli.from,
    last_sale_day: lastSaleDay,
    last_judge_day: lastJudgeDay,
    sale_days: nSaleDays,
    promise_window_days: WINDOW_DAYS,
    buyers_per_day: BUYERS_PER_DAY,
    llm_temperature: LLM_TEMPERATURE,
    llm_thinking: cli.thinking ?? 'model default',
    owner_goal: cli.goal,
    promise_rule: FULL_PROMISE ? 'full difference (cap = price)' : `capped (cap <= ${cli.capPct}% of price)`,
    ablations: { no_memo: cli.noMemo, no_chat: cli.noChat },
    bounds: {
      floor_rule: `${cli.floor} × agent store real price on D`,
      ceiling_rule: `${cli.ceiling} × max(agent store real price on the first day, on D)`,
      cap_rule: FULL_PROMISE ? 'cap = price paid (full difference, no cap)' : `0 <= cap <= ${cli.capPct}% of price charged`,
      floor_ratio: cli.floor,
      ceiling_ratio: cli.ceiling,
    },
    unit_cost_rule: '0.80 × agent store real price on D (20% gross margin assumption; also reported at 10% and 30%)',
    conditions: {
      a: 'Real price on D, no promise',
      b: FULL_PROMISE ? 'Real price on D, always promise (full difference)' : 'Real price on D, promise cap = min(10% of price, ceil(expected_drop_usd))',
      c: FULL_PROMISE
        ? 'Rule seller: undercut cheapest other store by $0.01 down to floor; promise (full difference) iff p_drop × expected_drop < 0.25 × (price − unit_cost)'
        : 'Rule seller: undercut cheapest other store by $0.01 down to floor; promise cap = min(10% of price, expected_drop_usd) if p_drop × min(cap, expected_drop) < 0.25 × (price − unit_cost)',
      d: FULL_PROMISE ? 'LLM sets promise on/off once per day (price = real price) with nightly strategy memo' : 'LLM sets promise cap once per day (price = real price) with nightly strategy memo',
      e: FULL_PROMISE
        ? 'LLM sets daily price & promise on/off, answers all 6 buyer messages in one batched call (personal price/promise within bounds or keep listing), and updates nightly strategy memo'
        : 'LLM sets daily price & cap, answers all 6 buyer messages in one batched call (personal price/cap within bounds or keep listing), and updates nightly strategy memo',
    },
    note: 'Demand and buyer personas are simulated; gross margin (10%/20%/30%) and staked promises are hypothetical; prices and 7-day drop risks come from real Channel3 histories and leak-free as-of models.',
  },
  totals_by_condition: Object.fromEntries(
    cli.conditions.map((c) => [c, conditionResults[c].totals]),
  ),
  conditions: conditionResults,
};

const outDir = new URL('../../experiments/seller-sim/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
// Named by the anonymised product code and store label (no brand or model in file names).
const code = (productLabel.match(/#[A-Z]\d\d/)?.[0] ?? 'product').slice(1);
const outFile = `${outDir}${code}-${agentStore.replace(/^Demo store /, '')}-${cli.mix}-s${cli.seed}${cli.tag ? `-${cli.tag}` : ''}.json`;
writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n');

console.log(`\n=== Seller-Agent Simulation: ${productLabel} (${agentStore}) ===`);
console.log(
  `Sale days: ${cli.from}..${lastSaleDay} (${nSaleDays}d, judged through ${lastJudgeDay}) | mix=${cli.mix} | seed=${cli.seed}`,
);
console.log(
  'Cond | Sales |  Revenue  |  Refunds  | Profit@10% | Profit@20% | Profit@30% | Clamps',
);
console.log(
  '-----+-------+-----------+-----------+------------+------------+------------+-------',
);
for (const c of cli.conditions) {
  const t = conditionResults[c].totals;
  const salesStr = `${t.sales}/${t.buyers_total}`.padStart(5);
  const revStr = `$${t.revenue_usd.toFixed(2)}`.padStart(9);
  const refStr = `$${t.refunds_usd.toFixed(2)}`.padStart(9);
  const p10Str = `$${t.profit_at_10pct_margin_usd.toFixed(2)}`.padStart(10);
  const p20Str = `$${t.profit_at_20pct_margin_usd.toFixed(2)}`.padStart(10);
  const p30Str = `$${t.profit_at_30pct_margin_usd.toFixed(2)}`.padStart(10);
  const clampStr = `${t.clamped_listings + t.clamped_buyer_offers}`.padStart(6);
  console.log(` (${c}) | ${salesStr} | ${revStr} | ${refStr} | ${p10Str} | ${p20Str} | ${p30Str} | ${clampStr}`);
}
console.log(`Saved: ${outFile}`);
