import pandas as pd
import pytest

from integrity.features import luck_z, pair_overlap, selections_frame, user_features
from integrity.football import implied_probability

T0 = pd.Timestamp("2026-10-01T12:00:00Z")


def bet(bet_id, user, sels, minutes=0, stake=10.0, status=None):
    status = status or ("won" if all(s["result"] == "won" for s in sels) else "lost")
    return {"bet_id": bet_id, "user_id": user, "created_at": T0 + pd.Timedelta(minutes=minutes), "stake": stake, "mode": "combined", "status": status, "selections": sels}


def sel(match, pick="Home", odd=2.0, result="won", **extra):
    return {"matchId": match, "betId": 1, "pick": pick, "odd": odd, "result": result, **extra}


def test_luck_z_is_zero_when_wins_match_the_odds():
    odds = pd.Series([2.0] * 100)
    p = implied_probability(2.0)
    wins = pd.Series([True] * round(100 * p) + [False] * (100 - round(100 * p)))
    assert luck_z(odds, wins) == pytest.approx(0.0, abs=0.25)


def test_luck_z_is_large_when_every_coin_flip_wins():
    assert luck_z(pd.Series([2.0] * 30), pd.Series([True] * 30)) > 5


def test_pair_overlap_spots_two_accounts_placing_the_same_slips():
    rows = []
    for i in range(6):
        slip = [sel(100 + i), sel(200 + i, "Draw", 3.2, "lost")]
        rows.append(bet(f"a{i}", "alice", slip, minutes=60 * i))
        rows.append(bet(f"b{i}", "bob", slip, minutes=60 * i + 2))  # bob copies alice 2 minutes later
    rows.append(bet("c0", "carol", [sel(100)], minutes=1))  # a stranger backing one of the same picks
    overlap = pair_overlap(pd.DataFrame(rows))
    assert overlap["alice"] == 1.0 and overlap["bob"] == 1.0
    assert overlap["carol"] == 0.0  # single pick, different slip


def test_copies_outside_the_window_do_not_count():
    rows = [bet("a", "alice", [sel(1)], minutes=0), bet("b", "bob", [sel(1)], minutes=30)]
    assert pair_overlap(pd.DataFrame(rows)).max() == 0.0


def test_price_outliers_are_measured_against_what_others_got():
    rows = [bet(f"n{i}", f"user{i}", [sel(7, odd=2.0)]) for i in range(5)]
    rows.append(bet("x", "sniper", [sel(7, odd=5.0)]))
    frame = selections_frame(pd.DataFrame(rows))
    assert frame.loc[frame["user_id"] == "sniper", "price_outlier"].all()
    assert not frame.loc[frame["user_id"] != "sniper", "price_outlier"].any()


def test_user_features_counts_refused_attempts_per_bet():
    bets = pd.DataFrame([bet("a", "alice", [sel(1)]), bet("b", "alice", [sel(2, result="lost")])])
    events = pd.DataFrame([{"user_id": "alice", "fixture_id": 1, "rule": "incident_cooldown", "created_at": T0}] * 3)
    f = user_features(bets, events)
    assert f.loc["alice", "refused_attempts"] == 3
    assert f.loc["alice", "refused_per_bet"] == 1.5


def test_pending_and_void_selections_are_ignored():
    bets = pd.DataFrame([bet("a", "alice", [sel(1, result="void")], status="won")])
    assert selections_frame(bets).empty
