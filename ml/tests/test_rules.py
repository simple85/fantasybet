from integrity.rules import hidden_goal_at_placement


def live_sel(minute, known_score, goals):
    return {"live": True, "context": {"minute": minute, "score": known_score}, "goals": goals}


def test_goal_before_the_bet_missing_from_our_score_is_hidden():
    assert hidden_goal_at_placement(live_sel(30, {"home": 0, "away": 0}, [{"minute": 29, "side": "home"}]))


def test_goal_in_the_same_minute_counts_as_possibly_hidden():
    assert hidden_goal_at_placement(live_sel(30, {"home": 0, "away": 0}, [{"minute": 31, "side": "away"}]))


def test_goal_already_in_our_score_is_not_hidden():
    assert not hidden_goal_at_placement(live_sel(30, {"home": 1, "away": 0}, [{"minute": 12, "side": "home"}]))


def test_a_later_goal_is_not_hidden():
    assert not hidden_goal_at_placement(live_sel(30, {"home": 0, "away": 0}, [{"minute": 60, "side": "home"}]))


def test_missing_data_is_not_evidence():
    assert not hidden_goal_at_placement({"live": True, "context": {}, "goals": None})
