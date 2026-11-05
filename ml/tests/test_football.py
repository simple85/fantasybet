import pytest

from integrity.football import implied_probability, outcome_probabilities, to_odds


def test_probabilities_sum_to_one():
    p = outcome_probabilities(1.6, 1.1)
    assert sum(p.values()) == pytest.approx(1.0)
    assert p["Home"] > p["Away"]  # the stronger scoring rate is the favourite


def test_a_late_lead_is_almost_decisive():
    p = outcome_probabilities(1.5, 1.5, score=(1, 0), minute=88)
    assert p["Home"] > 0.9


def test_odds_carry_the_bookmaker_margin():
    odds = to_odds(outcome_probabilities(1.4, 1.2), margin=0.06)
    assert sum(1 / o for o in odds.values()) == pytest.approx(1.06, abs=0.01)


def test_implied_probability_removes_the_margin():
    assert implied_probability(2.0, margin=0.06) == pytest.approx(0.5 / 1.06)
