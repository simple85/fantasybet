"""Scoring users: an unsupervised anomaly model plus the explicit rules.

Why unsupervised: we have no confirmed cheaters to learn from, and new abuse patterns won't look
like old ones. An Isolation Forest needs no labels. It builds random trees that split the data on
random features at random thresholds; unusual users get isolated in few splits, so a short average
path length means "anomalous". It answers "who is unlike everybody else?", not "who is a cheater?",
so a high score is a reason for a human to look, never an automatic ban.

Preprocessing: features have very different scales and outliers (that's the point), so they are
scaled with the median and interquartile range (RobustScaler) rather than mean and std, which the
outliers themselves would distort.

Final score per user (0-1): the anomaly percentile, raised to at least 0.9 when an explicit rule
fires. Flagged = a rule fired, or the user is among the most anomalous FLAG_TOP_SHARE of the users
NO rule caught AND has at least one concrete reason a reviewer can check ("unusual somehow" is
not actionable). The model's job is finding what the rules miss, so it shouldn't spend its review
slots on users the rules already flagged.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler

from .features import FEATURES
from .rules import rule_hits

FLAG_TOP_SHARE = 0.03
MIN_SELECTIONS = 5  # below this a user's statistics are too noisy to score

REASON_TEXT = {
    "past_posting": "placed winning live bets while a goal was not yet in our feed (likely past-posting)",
    "shared_slips": "places the same slips as another account within minutes (possible multi-accounting)",
    "odds_glitch_hunting": "mostly bets at prices far above what everyone else got (feed errors)",
    "repeated_refused_live_bets": "repeatedly tried to bet live right after goals or cards",
    "luck_z": "wins far more often than their odds imply",
    "live_luck_z": "wins far more often than the odds imply on live bets",
    "hidden_goal_rate": "many live bets placed just after a goal the feed had not reported yet",
    "stale_odds_share": "many live bets on odds that had not updated for 12+ seconds",
    "refused_per_bet": "many refused live attempts compared to placed bets",
    "pair_overlap": "many bets identical to one other account's",
    "price_outlier_share": "often bets at odds far above what other users got",
    "live_share": "bets almost only live",
    "roi": "unusually high return on stakes",
}

# A feature is only worth mentioning when it is both an outlier (robust z > 2) and large in
# absolute terms: in a uniform population a tiny value can be a statistical outlier and still mean
# nothing. Only high values count (a low luck_z is just an unlucky bettor).
MIN_NOTEWORTHY = {
    "luck_z": 2.5,
    "live_luck_z": 2.5,
    "hidden_goal_rate": 0.35,
    "stale_odds_share": 0.3,
    "price_outlier_share": 0.2,
    "refused_per_bet": 0.2,
    "pair_overlap": 0.25,
    "live_share": 0.8,
    "roi": 0.5,
}
# A feature that says the same as a rule which already fired is not repeated.
SAME_AS_RULE = {
    "hidden_goal_rate": "past_posting",
    "price_outlier_share": "odds_glitch_hunting",
    "pair_overlap": "shared_slips",
    "refused_per_bet": "repeated_refused_live_bets",
}


@dataclass
class ScoringResult:
    scores: pd.DataFrame  # index user_id: score, anomaly, flagged, reasons


def explain(features: pd.DataFrame, top: int = 3) -> dict[str, list[str]]:
    """Per user, the features that stand out most from the population (robust z > 2), worst first."""
    med = features[FEATURES].median()
    iqr = (features[FEATURES].quantile(0.75) - features[FEATURES].quantile(0.25)).replace(0, np.nan)
    spread = iqr.fillna(features[FEATURES].std()).replace(0, 1.0)
    z = (features[FEATURES] - med) / spread
    out = {}
    for user, row in z.iterrows():
        strong = row[(row > 2) & (features.loc[user, FEATURES] >= pd.Series(MIN_NOTEWORTHY))].sort_values(ascending=False)
        out[user] = list(strong.index[:top])
    return out


def score_users(features: pd.DataFrame, seed: int = 42) -> ScoringResult:
    eligible = features[features["n_selections"] >= MIN_SELECTIONS]
    X = RobustScaler().fit_transform(eligible[FEATURES].fillna(0.0))
    forest = IsolationForest(n_estimators=400, random_state=seed).fit(X)
    raw = -forest.score_samples(X)  # higher = more anomalous
    anomaly = pd.Series(raw, index=eligible.index).rank(pct=True)

    rules = rule_hits(eligible)
    why = explain(eligible)
    unexplained = anomaly.drop(index=list(rules), errors="ignore")
    unexplained = unexplained[[bool(why[u]) for u in unexplained.index]]
    n_slots = max(1, round(FLAG_TOP_SHARE * len(eligible)))
    anomaly_flags = set(unexplained.sort_values(ascending=False).index[:n_slots])
    rows = {}
    for user in eligible.index:
        fired = rules.get(user, [])
        a = float(anomaly[user])
        score = max(a, 0.9) if fired else a
        flagged = bool(fired) or user in anomaly_flags
        reasons = fired + [f for f in why[user] if SAME_AS_RULE.get(f) not in fired]
        rows[user] = {
            "score": round(score, 4),
            "anomaly": round(a, 4),
            "flagged": flagged,
            "rules": fired,
            "reasons": [REASON_TEXT[r] for r in dict.fromkeys(reasons)] if flagged else [],
        }
    return ScoringResult(scores=pd.DataFrame.from_dict(rows, orient="index").sort_values("score", ascending=False))


def anomaly_only(features: pd.DataFrame, seed: int = 42) -> pd.Series:
    """Isolation Forest percentile without the rules (for comparing the parts in evaluate.py)."""
    eligible = features[features["n_selections"] >= MIN_SELECTIONS]
    X = RobustScaler().fit_transform(eligible[FEATURES].fillna(0.0))
    raw = -IsolationForest(n_estimators=400, random_state=seed).fit(X).score_samples(X)
    return pd.Series(raw, index=eligible.index).rank(pct=True)
