// Serves the trained failure-probability models (server/model/*.json, written
// by ml/train.py). A missing model file is an error, not a default.
import { readFileSync } from 'node:fs';
import { FEATURE_NAMES, type Features } from './features.ts';

export interface ModelFile {
  target: 'drop14' | 'lowest7';
  trained_at: string;
  features: string[];
  mean: number[];
  scale: number[];
  coef: number[];
  intercept: number;
  data: Record<string, unknown>;
  metrics_test: Record<string, unknown>;
  reliability_test: { bin_low: number; bin_high: number; n: number; mean_predicted: number; observed_rate: number }[];
  shortfall_fraction: { mean: number; median: number; n: number };
}

const cache = new Map<string, ModelFile>();

export function loadModel(target: 'drop14' | 'lowest7'): ModelFile {
  const hit = cache.get(target);
  if (hit) return hit;
  const path = new URL(`../model/${target}.json`, import.meta.url);
  let m: ModelFile;
  try {
    m = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Model ${target} not found at ${path.pathname}. Run: npm -w server run dataset && (cd ml && uv run train.py)`);
  }
  const expected = FEATURE_NAMES.join(',');
  if (m.features.join(',') !== expected) {
    throw new Error(`Model ${target} was trained on features [${m.features}] but the server computes [${expected}]; retrain.`);
  }
  cache.set(target, m);
  return m;
}

export interface ModelWeights {
  features: string[];
  mean: number[];
  scale: number[];
  coef: number[];
  intercept: number;
  positive_rate_train?: number;
  shortfall_fraction: { mean: number; median: number; n: number };
}

export interface ReplayModel extends ModelWeights {
  kind: 'as_of' | 'out_of_group';
  as_of_model?: string;
  cutoff_day?: string;
  n_train: number;
  n_test?: number;
  fold?: number;
}

export interface ReplayModelFile {
  target: 'drop14-replay';
  trained_at: string;
  horizon_days: number;
  min_train_rows: number;
  earliest_as_of: string | null;
  latest_as_of: string | null;
  features: string[];
  by_as_of: Record<
    string,
    Omit<ModelWeights, 'features'> & {
      as_of: string;
      cutoff_day: string;
      n_train: number;
      n_test: number;
      units_train: number;
      units_test: number;
      metrics_test: Record<string, number | null>;
    }
  >;
  out_of_group: {
    n_folds: number;
    n_rows: number;
    n_units: number;
    metrics_oof: Record<string, number | null>;
    reliability_oof: { bin_low: number; bin_high: number; n: number; mean_predicted: number; observed_rate: number }[];
    unit_fold: Record<string, number>;
    folds: (Omit<ModelWeights, 'features'> & { fold: number; n_train: number; units_train: number })[];
  };
}

const replayCache = new Map<number, ReplayModelFile>();

// horizon 14: buyer-app replays; horizon 7: seller-agent simulation (docs/concept.md §27).
export function loadReplayModelFile(horizon: 14 | 7 = 14): ReplayModelFile {
  const cached = replayCache.get(horizon);
  if (cached) return cached;
  const path = new URL(`../model/drop${horizon}-replay.json`, import.meta.url);
  let m: ReplayModelFile;
  try {
    m = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Model drop${horizon}-replay not found at ${path.pathname}. Run: npm -w server run dataset && (cd ml && uv run train.py ${horizon === 7 ? 'replay7' : 'replay'})`);
  }
  const expected = FEATURE_NAMES.join(',');
  if (m.features.join(',') !== expected) {
    throw new Error(`Model drop${horizon}-replay was trained on features [${m.features}] but the server computes [${expected}]; retrain.`);
  }
  replayCache.set(horizon, m);
  return m;
}

// Picks the leak-free model for a past-day replay on `asOf` for product group `unit`:
// - If at least `min_train_rows` 14-day windows had already resolved by `asOf`
//   (t <= asOf - 14), uses that strictly causal temporal model.
// - For earlier days D before 14-day windows could resolve in the 30-day history,
//   uses the out-of-group fold model trained with `unit` held out.
export function loadReplayModel(asOf: string, unit: string, horizon: 14 | 7 = 14): ReplayModel {
  const m = loadReplayModelFile(horizon);
  const eligible = Object.keys(m.by_as_of)
    .filter((d) => d <= asOf)
    .sort();
  if (eligible.length > 0) {
    const k = eligible.at(-1)!;
    const sub = m.by_as_of[k];
    return { kind: 'as_of', features: m.features, as_of_model: k, cutoff_day: sub.cutoff_day, n_train: sub.n_train, n_test: sub.n_test, mean: sub.mean, scale: sub.scale, coef: sub.coef, intercept: sub.intercept, positive_rate_train: sub.positive_rate_train, shortfall_fraction: sub.shortfall_fraction };
  }
  const foldIdx = m.out_of_group.unit_fold[unit] ?? 0;
  const fold = m.out_of_group.folds[foldIdx] ?? m.out_of_group.folds[0];
  return { kind: 'out_of_group', features: m.features, fold: fold.fold, n_train: fold.n_train, mean: fold.mean, scale: fold.scale, coef: fold.coef, intercept: fold.intercept, positive_rate_train: fold.positive_rate_train, shortfall_fraction: fold.shortfall_fraction };
}

export function predict(m: ModelWeights, f: Features): number {
  let z = m.intercept;
  m.features.forEach((name, i) => {
    z += m.coef[i] * (((f as any)[name] - m.mean[i]) / m.scale[i]);
  });
  return 1 / (1 + Math.exp(-z));
}

// Per-feature contribution on the log-odds scale (for "why" explanations).
export function explain(m: ModelWeights, f: Features, top = 3): { feature: string; contribution: number }[] {
  return m.features
    .map((name, i) => ({ feature: name, contribution: m.coef[i] * (((f as any)[name] - m.mean[i]) / m.scale[i]) }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, top);
}
