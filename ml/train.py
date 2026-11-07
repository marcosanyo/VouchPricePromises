"""Train the failure-probability models from Channel3 price history.

Input: data/ml/{drop14,lowest7}.csv written by server/src/jobs/dataset.ts.
Output: server/model/{target}.json with the served logistic regression
(standardisation + coefficients), held-out metrics for it and for a gradient
boosting comparison, the reliability table, and the observed shortfall size.

Split is by product group (column `split`), so no item appears in both sets.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "ml"
OUT = ROOT / "server" / "model"
META = {"unit", "product_id", "day", "split", "y", "magnitude"}


def metrics(y, p):
    out = {
        "log_loss": float(log_loss(y, p, labels=[0, 1])),
        "brier": float(brier_score_loss(y, p)),
        "base_rate_brier": float(brier_score_loss(y, np.full_like(p, y.mean()))),
    }
    out["auc"] = float(roc_auc_score(y, p)) if len(set(y)) == 2 else None
    return out


def reliability(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.sum() == 0:
            continue
        rows.append({
            "bin_low": float(lo),
            "bin_high": float(hi),
            "n": int(m.sum()),
            "mean_predicted": float(p[m].mean()),
            "observed_rate": float(y[m].mean()),
        })
    return rows


def train(target: str):
    df = pd.read_csv(DATA / f"{target}.csv")
    feats = [c for c in df.columns if c not in META]
    tr, te = df[df.split == "train"], df[df.split == "test"]
    if len(tr) < 50 or len(te) < 20 or tr.y.nunique() < 2:
        sys.exit(f"{target}: not enough data (train={len(tr)}, test={len(te)}, positives={int(tr.y.sum())})")

    Xtr, Xte = tr[feats].to_numpy(float), te[feats].to_numpy(float)
    ytr, yte = tr.y.to_numpy(int), te.y.to_numpy(int)
    mu, sd = Xtr.mean(0), Xtr.std(0)
    sd[sd == 0] = 1.0

    lr = LogisticRegression(C=1.0, max_iter=2000)
    lr.fit((Xtr - mu) / sd, ytr)
    p_lr = lr.predict_proba((Xte - mu) / sd)[:, 1]

    gb = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, random_state=0)
    gb.fit(Xtr, ytr)
    p_gb = gb.predict_proba(Xte)[:, 1]

    pos = df[(df.split == "train") & (df.y == 1)].magnitude
    model = {
        "target": target,
        "served": "logistic_regression",
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": {
            "source": "Channel3 price-tracking history (daily, up to 30 days)",
            "days": [str(df.day.min()), str(df.day.max())],
            "n_train": int(len(tr)),
            "n_test": int(len(te)),
            "units_train": int(tr.unit.nunique()),
            "units_test": int(te.unit.nunique()),
            "positive_rate_train": float(ytr.mean()),
            "positive_rate_test": float(yte.mean()),
        },
        "features": feats,
        "mean": mu.tolist(),
        "scale": sd.tolist(),
        "coef": lr.coef_[0].tolist(),
        "intercept": float(lr.intercept_[0]),
        "metrics_test": {"logistic_regression": metrics(yte, p_lr), "gradient_boosting": metrics(yte, p_gb)},
        "reliability_test": reliability(yte, p_lr),
        # Shortfall when the claim fails, as a fraction of price (train rows).
        "shortfall_fraction": {
            "mean": float(pos.mean()) if len(pos) else 0.0,
            "median": float(pos.median()) if len(pos) else 0.0,
            "n": int(len(pos)),
        },
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{target}.json").write_text(json.dumps(model, indent=2) + "\n")
    m = model["metrics_test"]
    print(f"{target}: train={len(tr)} test={len(te)} pos_rate={ytr.mean():.3f}")
    for k, v in m.items():
        print(f"  {k:20s} logloss={v['log_loss']:.4f} brier={v['brier']:.4f} (base {v['base_rate_brier']:.4f}) auc={v['auc']}")


def fit_lr(tr: pd.DataFrame, feats: list[str]):
    Xtr = tr[feats].to_numpy(float)
    ytr = tr.y.to_numpy(int)
    mu, sd = Xtr.mean(0), Xtr.std(0)
    sd[sd == 0] = 1.0
    lr = LogisticRegression(C=1.0, max_iter=2000)
    lr.fit((Xtr - mu) / sd, ytr)
    pos = tr[tr.y == 1].magnitude
    return {
        "mean": mu.tolist(),
        "scale": sd.tolist(),
        "coef": lr.coef_[0].tolist(),
        "intercept": float(lr.intercept_[0]),
        "positive_rate_train": float(ytr.mean()),
        "shortfall_fraction": {
            "mean": float(pos.mean()) if len(pos) else 0.0,
            "median": float(pos.median()) if len(pos) else 0.0,
            "n": int(len(pos)),
        },
    }, lr, mu, sd


def train_replay(horizon_days: int = 14, min_train_rows: int = 300, n_folds: int = 5):
    """Train leak-free models for past-day replays (server/model/drop{horizon}-replay.json;
    7 days for the seller-agent simulation, docs/concept.md §27).

    1. by_as_of[D]: trained only on rows at t <= D - 14 (whose 14-day outcome was
       already resolved on or before D). Used whenever at least `min_train_rows`
       resolved training rows exist by D.
    2. out_of_group: 5-fold GroupKFold by product group (`unit`). For early replay
       days D where fewer than `min_train_rows` 14-day windows had resolved in the
       30-day Channel3 history, predictions for a product group come from the fold
       model that excluded that product group from training.
    """
    name = f"drop{horizon_days}-replay"
    df = pd.read_csv(DATA / f"drop{horizon_days}.csv")
    feats = [c for c in df.columns if c not in META]
    by_as_of = {}
    for cutoff in sorted(df.day.unique()):
        sub = df[df.day <= cutoff]
        tr, te = sub[sub.split == "train"], sub[sub.split == "test"]
        if len(tr) < min_train_rows or len(te) < 30 or tr.y.nunique() < 2:
            continue
        as_of = (pd.Timestamp(cutoff) + pd.Timedelta(days=horizon_days)).strftime("%Y-%m-%d")
        weights, lr, mu, sd = fit_lr(tr, feats)
        Xte = te[feats].to_numpy(float)
        yte = te.y.to_numpy(int)
        p_lr = lr.predict_proba((Xte - mu) / sd)[:, 1]
        by_as_of[as_of] = {
            "as_of": as_of,
            "cutoff_day": str(cutoff),
            "n_train": int(len(tr)),
            "n_test": int(len(te)),
            "units_train": int(tr.unit.nunique()),
            "units_test": int(te.unit.nunique()),
            "metrics_test": metrics(yte, p_lr),
            **weights,
        }

    units = sorted(df.unit.unique())
    fold_of = {u: i % n_folds for i, u in enumerate(units)}
    folds = df.unit.map(fold_of)
    oof_pred = np.zeros(len(df))
    fold_models = []
    for f in range(n_folds):
        tr, te = df[folds != f], df[folds == f]
        weights, lr, mu, sd = fit_lr(tr, feats)
        Xte = te[feats].to_numpy(float)
        oof_pred[folds == f] = lr.predict_proba((Xte - mu) / sd)[:, 1]
        fold_models.append({"fold": f, "n_train": int(len(tr)), "units_train": int(tr.unit.nunique()), **weights})

    y_all = df.y.to_numpy(int)
    oof_metrics = metrics(y_all, oof_pred)
    out = {
        "target": name,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "horizon_days": horizon_days,
        "min_train_rows": min_train_rows,
        "earliest_as_of": min(by_as_of.keys()) if by_as_of else None,
        "latest_as_of": max(by_as_of.keys()) if by_as_of else None,
        "features": feats,
        "by_as_of": by_as_of,
        "out_of_group": {
            "n_folds": n_folds,
            "n_rows": int(len(df)),
            "n_units": int(len(units)),
            "metrics_oof": oof_metrics,
            "reliability_oof": reliability(y_all, oof_pred),
            "unit_fold": fold_of,
            "folds": fold_models,
        },
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps(out, indent=2) + "\n")
    print(f"{name}: as_of models={len(by_as_of)} ({out['earliest_as_of']}..{out['latest_as_of']}), out_of_group OOF brier={oof_metrics['brier']:.4f} auc={oof_metrics['auc']:.3f}")


if __name__ == "__main__":
    targets = sys.argv[1:] or ["drop14", "lowest7", "replay"]
    for t in targets:
        if t in ("replay", "drop14-replay"):
            train_replay()
        elif t in ("replay7", "drop7-replay"):
            train_replay(horizon_days=7)
        else:
            train(t)
