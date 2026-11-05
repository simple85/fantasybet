"""Explicit rules: patterns specific enough to name without a model.

Past-posting leaves a footprint we can check exactly, after the match:
  * when the bet was placed, the server stored the score it knew (context.score) and the minute
  * after the match, settlement stored the real goal timeline (selection.goals, minute of each goal)
If more goals had really happened by the time of the bet than the server's score showed, the
user bet while a goal was not yet in our feed. That happens to honest users occasionally (a goal
in the same minute as the bet), so one hit means little; many hits, on winning bets, does not.

Minute resolution: a goal "in minute g" happened during [g-1, g) minutes of play. A bet in minute
m (m whole minutes played) came after every goal with g <= m for sure, and possibly after a goal
with g == m + 1 (same minute). We count both, because past-posting happens within seconds.
"""

from __future__ import annotations

import pandas as pd

PAST_POSTING_MIN_HITS = 3
PAST_POSTING_MIN_RATE = 0.3
SHARED_SLIPS_MIN_SHARE = 0.5
SHARED_SLIPS_MIN_BETS = 5
PRICE_OUTLIER_MIN_SHARE = 0.4
PRICE_OUTLIER_MIN_SELECTIONS = 5
REFUSED_MIN_ATTEMPTS = 4


def hidden_goal_at_placement(sel: dict) -> bool:
    """True if a goal had (probably) happened before this live bet but wasn't in the server's score yet."""
    ctx = sel.get("context") or {}
    goals = sel.get("goals")
    minute, score = ctx.get("minute"), ctx.get("score")
    if minute is None or not score or goals is None:
        return False
    known = (score.get("home") or 0) + (score.get("away") or 0)
    happened = sum(1 for g in goals if g["minute"] <= minute + 1)
    return happened > known


def rule_hits(features: pd.DataFrame) -> dict[str, list[str]]:
    """Per user, the rules they trip, as short reason codes."""
    hits: dict[str, list[str]] = {}
    for user, f in features.iterrows():
        reasons = []
        if f["hidden_goal_hits"] >= PAST_POSTING_MIN_HITS and f["hidden_goal_rate"] >= PAST_POSTING_MIN_RATE:
            reasons.append("past_posting")
        if f["pair_overlap"] >= SHARED_SLIPS_MIN_SHARE and f["n_bets"] >= SHARED_SLIPS_MIN_BETS:
            reasons.append("shared_slips")
        if f["price_outlier_share"] >= PRICE_OUTLIER_MIN_SHARE and f["n_selections"] >= PRICE_OUTLIER_MIN_SELECTIONS:
            reasons.append("odds_glitch_hunting")
        if f["refused_attempts"] >= REFUSED_MIN_ATTEMPTS:
            reasons.append("repeated_refused_live_bets")
        if reasons:
            hits[user] = reasons
    return hits
