"""Per-user features for the integrity model, computed from stored bets.

Input: the bets table as a DataFrame (one row per bet, `selections` as stored by server.js)
and the refused live attempts (integrity_events). Output: one row per user.

The signals, and why each one points at a kind of abuse:

  luck_z            How far above expectation a user wins. Each settled selection at odds o is
                    a coin flip that comes up "won" with probability p ≈ 1/o (minus margin).
                    Wins W over n selections then have mean Σp and variance Σp(1-p), so
                        z = (W - Σp) / sqrt(Σp(1-p))
                    is ~N(0,1) for an honest bettor. Long-run z of +4 is about 1 in 30 000.
  live_luck_z       The same, for live selections only (where past-posting happens).
  hidden_goal_rate  Share of live bets placed when a goal had (probably) already happened but
                    the server's score didn't show it yet, and the bet then won. See rules.py.
  stale_odds_share  Share of live bets taken on odds that hadn't moved for 12+ seconds.
  price_outlier_share
                    Share of selections taken at odds far above what other users got for the
                    same pick (>= 1.5x the median): a feed error someone was waiting for.
  refused_per_bet   Live attempts the guard refused, per placed bet: someone repeatedly trying
                    to bet right after goals.
  pair_overlap      The largest share of a user's bets that ONE other account placed identically
                    within 10 minutes. Strangers backing the same favourite overlap a little with
                    many people; accounts run by one person overlap heavily with the same partner.
  live_share, roi   Context: how much they bet live, and their return on stakes.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .football import implied_probability
from .rules import hidden_goal_at_placement

SHARED_SLIP_WINDOW = pd.Timedelta(minutes=10)
STALE_ODDS_S = 12.0
PRICE_OUTLIER_RATIO = 1.5

FEATURES = [
    "luck_z",
    "live_luck_z",
    "hidden_goal_rate",
    "stale_odds_share",
    "price_outlier_share",
    "refused_per_bet",
    "pair_overlap",
    "live_share",
    "roi",
]


def selections_frame(bets: pd.DataFrame) -> pd.DataFrame:
    """One row per selection, with the stored live snapshot spread into columns."""
    rows = []
    for bet in bets.itertuples(index=False):
        for sel in bet.selections:
            if sel.get("result") not in ("won", "lost"):
                continue  # pending or void selections say nothing about skill or luck
            ctx = sel.get("context") or {}
            rows.append({
                "bet_id": bet.bet_id,
                "user_id": bet.user_id,
                "market": (sel["matchId"], sel["betId"], sel["pick"], bool(sel.get("live")), (ctx.get("minute") or 0) // 5),
                "odd": float(sel["odd"]),
                "won": sel["result"] == "won",
                "live": bool(sel.get("live")),
                "odds_age_s": (ctx.get("oddsAgeMs") or 0) / 1000,
                "hidden_goal_win": bool(sel.get("live")) and sel["result"] == "won" and hidden_goal_at_placement(sel),
            })
    frame = pd.DataFrame(rows, columns=["bet_id", "user_id", "market", "odd", "won", "live", "odds_age_s", "hidden_goal_win"])
    # Consensus price: the median odds everyone got for the same pick (live: same 5-minute window).
    # A single selection on a market has no consensus to compare with; treat it as normal.
    counts = frame.groupby("market")["odd"].transform("size")
    consensus = frame.groupby("market")["odd"].transform("median")
    frame["price_outlier"] = (counts >= 3) & (frame["odd"] >= PRICE_OUTLIER_RATIO * consensus)
    return frame


def luck_z(odds: pd.Series, won: pd.Series) -> float:
    """Standardised excess wins: (wins - expected) / standard deviation, under fair-odds coin flips."""
    if len(odds) == 0:
        return 0.0
    p = odds.map(implied_probability)
    var = float((p * (1 - p)).sum())
    return float((won.sum() - p.sum()) / math.sqrt(var)) if var > 0 else 0.0


def pair_overlap(bets: pd.DataFrame) -> pd.Series:
    """Per user: the largest share of their bets that one single other account placed identically
    (same selections) within SHARED_SLIP_WINDOW."""
    sig = bets["selections"].map(lambda sels: tuple(sorted((s["matchId"], s["betId"], s["pick"]) for s in sels)))
    # Seconds since the epoch, computed explicitly: the integer value of a timestamp depends on its
    # storage unit (pandas 3 defaults to microseconds), which silently broke an earlier version.
    seconds = (pd.to_datetime(bets["created_at"], utc=True) - pd.Timestamp(0, tz="UTC")).dt.total_seconds()
    frame = pd.DataFrame({"sig": sig, "user": bets["user_id"], "at": seconds})
    shared_with: dict[tuple[str, str], set] = {}
    for _, group in frame.groupby("sig"):
        if group["user"].nunique() < 2:
            continue
        rows = list(group.itertuples())
        for a in rows:
            for b in rows:
                if a.user != b.user and abs(a.at - b.at) <= SHARED_SLIP_WINDOW.total_seconds():
                    shared_with.setdefault((a.user, b.user), set()).add(a.Index)
    n_bets = frame.groupby("user").size()
    best: dict[str, float] = {}
    for (user, _other), idxs in shared_with.items():
        best[user] = max(best.get(user, 0.0), len(idxs) / n_bets[user])
    return pd.Series(best, dtype=float).reindex(n_bets.index).fillna(0.0)


def user_features(bets: pd.DataFrame, events: pd.DataFrame | None = None) -> pd.DataFrame:
    """One row per user with the FEATURES columns plus counts used for explanations."""
    if bets.empty:
        return pd.DataFrame(columns=["n_bets", "n_selections", "n_live", *FEATURES])
    bets = bets.reset_index(drop=True)
    sels = selections_frame(bets)
    overlap = pair_overlap(bets)
    settled = bets[bets["status"].isin(["won", "lost"])]

    out = {}
    for user, user_bets in bets.groupby("user_id"):
        us = sels[sels["user_id"] == user]
        live = us[us["live"]]
        stakes = settled.loc[settled["user_id"] == user]
        returns = sum(
            row.stake * math.prod(s["odd"] for s in row.selections)
            for row in stakes.itertuples(index=False) if row.status == "won"
        )
        staked = float(stakes["stake"].sum())
        out[user] = {
            "n_bets": len(user_bets),
            "n_selections": len(us),
            "n_live": len(live),
            "luck_z": luck_z(us["odd"], us["won"]),
            "live_luck_z": luck_z(live["odd"], live["won"]),
            "hidden_goal_hits": int(live["hidden_goal_win"].sum()),
            "hidden_goal_rate": float(live["hidden_goal_win"].mean()) if len(live) else 0.0,
            "stale_odds_share": float((live["odds_age_s"] >= STALE_ODDS_S).mean()) if len(live) else 0.0,
            "price_outlier_share": float(us["price_outlier"].mean()) if len(us) else 0.0,
            "refused_attempts": 0,
            "refused_per_bet": 0.0,
            "pair_overlap": float(overlap.get(user, 0.0)),
            "live_share": len(live) / len(us) if len(us) else 0.0,
            "roi": (returns - staked) / staked if staked else 0.0,
        }
    features = pd.DataFrame.from_dict(out, orient="index")
    if events is not None and not events.empty:
        refused = events.groupby("user_id").size()
        features["refused_attempts"] = refused.reindex(features.index).fillna(0).astype(int)
        features["refused_per_bet"] = features["refused_attempts"] / features["n_bets"]
    features.index.name = "user_id"
    return features
