import pandas as pd
import pytest

from integrity.__main__ import main
from integrity.features import user_features
from integrity.model import score_users
from integrity.synthetic import generate


@pytest.fixture(scope="module")
def scored():
    data = generate(seed=11)
    result = score_users(user_features(data.bets, data.events)).scores
    return result.assign(kind=pd.Series(data.labels))


def test_rule_based_cheaters_are_all_flagged_with_reasons(scored):
    for kind in ("past_poster", "glitch_sniper", "ring"):
        group = scored[scored["kind"] == kind]
        assert group["flagged"].all(), kind
        assert group["reasons"].map(len).min() >= 1


def test_most_honest_users_are_left_alone(scored):
    honest = scored[scored["kind"].isin(["recreational", "skilled"])]
    assert honest["flagged"].mean() < 0.05


def test_every_flag_has_a_reason_a_reviewer_can_check(scored):
    assert scored.loc[scored["flagged"], "reasons"].map(len).min() >= 1


def test_scores_are_between_0_and_1(scored):
    assert scored["score"].between(0, 1).all()


def test_demo_command_runs(capsys):
    assert main(["demo", "--seed", "4"]) == 0
    assert "flagged for review" in capsys.readouterr().out
