"""Football maths shared by the simulator: match outcome probabilities and bookmaker odds.

Goals in football are well described by a Poisson process: each team scores at a steady
rate (goals per 90 minutes), independently of the other. From that we can price the
1X2 market (home win / draw / away win) at any moment of a match:

    remaining goals for each team ~ Poisson(rate * minutes_left / 90)
    P(final result) = sum over all remaining-goal combinations of their probabilities

A bookmaker turns probabilities into odds and adds a margin ("overround") on top:
    odd = 1 / (p * (1 + margin))
so the implied probabilities 1/odd of all outcomes add up to 1 + margin instead of 1.
"""

from __future__ import annotations

import math

MAX_GOALS = 10  # remaining goals beyond this have negligible probability


def poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * lam**k / math.factorial(k)


def outcome_probabilities(home_rate: float, away_rate: float, score: tuple[int, int] = (0, 0), minute: float = 0.0) -> dict[str, float]:
    """P(Home), P(Draw), P(Away) for the final result, given the score at `minute`."""
    left = max(0.0, (90.0 - minute) / 90.0)
    lh, la = home_rate * left, away_rate * left
    ph = [poisson_pmf(k, lh) for k in range(MAX_GOALS + 1)]
    pa = [poisson_pmf(k, la) for k in range(MAX_GOALS + 1)]
    probs = {"Home": 0.0, "Draw": 0.0, "Away": 0.0}
    for gh, p_h in enumerate(ph):
        for ga, p_a in enumerate(pa):
            final_h, final_a = score[0] + gh, score[1] + ga
            key = "Home" if final_h > final_a else "Away" if final_a > final_h else "Draw"
            probs[key] += p_h * p_a
    total = sum(probs.values())
    return {k: v / total for k, v in probs.items()}


def to_odds(probs: dict[str, float], margin: float = 0.06) -> dict[str, float]:
    """Bookmaker odds with a margin, rounded like real odds and never below 1.01."""
    return {k: max(1.01, round(1.0 / (p * (1.0 + margin)), 2)) for k, p in probs.items()}


def implied_probability(odd: float, margin: float = 0.06) -> float:
    """Best estimate of the true probability behind a price: remove the margin from 1/odd."""
    return min(0.999, (1.0 / odd) / (1.0 + margin))
