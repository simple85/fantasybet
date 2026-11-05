"""Synthetic FantasyBet data with known cheaters, for developing and evaluating the detector.

Why synthetic: the real site has a handful of friendly users, far too few (and no confirmed
cheaters) to measure a detector on. So we simulate a betting platform that behaves like the
real one, plant cheaters whose behaviour we control, and check whether the detector finds them
without being told who they are. The labels are only used for evaluation, never for training.

What is simulated, mirroring server.js / integrity.js:
  * matches with goals at random times (Poisson), priced with a Poisson model + bookmaker margin
  * the feed delay: the server learns about a goal LAG seconds after it happened
  * the live guard: no live bets for 30 s after the server learns of a goal
  * what the server stores per live selection: minute, score as the server knew it, odds age,
    time since the last known goal, plus the real goal timeline after settlement
  * refused live attempts (integrity_events)

User types:
  recreational  most users: pre-match accumulators and singles, some live bets, no edge
  skilled       honest but good: finds a small genuine edge (should NOT be flagged)
  past_poster   cheater: sees goals on TV before the feed, bets on the scoring team at the
                pre-goal price in the seconds before the server knows
  glitch_sniper cheater: waits for the odds feed to publish a wrong price (a data error, 2-3x the
                fair odds, for a few seconds) and bets on it before it is corrected
  ring          cheaters: groups of accounts placing the same slips (multi-accounting)
  insider       HELD-OUT cheater no rule was written for: knows some results in advance (a
                fixed match, leaked team news) and backs long-odds outcomes. Only the
                unsupervised anomaly score can find it; it tests whether the detector
                generalises beyond the patterns it was designed around.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .football import implied_probability, outcome_probabilities, to_odds

PICKS = ("Home", "Draw", "Away")
PREMATCH_BET_ID, LIVE_BET_ID = 1, 59
GUARD_COOLDOWN_S = 30
START = pd.Timestamp("2026-09-01T12:00:00Z")
ABUSE_KINDS = {"past_poster", "glitch_sniper", "ring", "insider"}


@dataclass
class Match:
    id: int
    kickoff: pd.Timestamp
    home_rate: float
    away_rate: float
    goals: list[tuple[float, str]] = field(default_factory=list)  # (second of play, "home"|"away")
    feed_lag: list[float] = field(default_factory=list)            # seconds until the server knew each goal

    def score_at(self, second: float, known_only: bool = False) -> tuple[int, int]:
        h = a = 0
        for (t, side), lag in zip(self.goals, self.feed_lag):
            happened = t + (lag if known_only else 0)
            if happened <= second:
                h += side == "home"
                a += side == "away"
        return h, a

    def last_known_goal(self, second: float) -> float | None:
        known = [t + lag for (t, _), lag in zip(self.goals, self.feed_lag) if t + lag <= second]
        return max(known) if known else None

    def final(self) -> tuple[int, int]:
        return self.score_at(90 * 60)

    def result(self) -> str:
        h, a = self.final()
        return "Home" if h > a else "Away" if a > h else "Draw"

    def goal_timeline(self) -> list[dict]:
        return [{"minute": int(t // 60) + 1, "side": side} for t, side in self.goals]


def make_matches(rng: np.random.Generator, n: int) -> list[Match]:
    matches = []
    for i in range(n):
        m = Match(
            id=100_000 + i,
            kickoff=START + pd.Timedelta(hours=int(rng.integers(0, 24 * 60))),
            home_rate=float(rng.uniform(1.0, 2.0)),
            away_rate=float(rng.uniform(0.7, 1.6)),
        )
        for side, rate in (("home", m.home_rate), ("away", m.away_rate)):
            for _ in range(rng.poisson(rate)):
                m.goals.append((float(rng.uniform(60, 90 * 60 - 60)), side))
        m.goals.sort()
        m.feed_lag = [float(rng.uniform(5, 20)) for _ in m.goals]
        matches.append(m)
    return matches


class Simulator:
    def __init__(self, seed: int = 7, n_matches: int = 600):
        self.rng = np.random.default_rng(seed)
        self.matches = make_matches(self.rng, n_matches)
        self.bets: list[dict] = []
        self.events: list[dict] = []
        self.labels: dict[str, str] = {}
        self._bet_seq = 0

    # ── pricing as the server would ──
    def prematch_odds(self, m: Match) -> dict[str, float]:
        return to_odds(outcome_probabilities(m.home_rate, m.away_rate))

    def live_odds(self, m: Match, second: float, stale_s: float = 0.0) -> dict[str, float]:
        """Live odds as the feed shows them: based on the score the server knows, `stale_s` seconds old."""
        seen_at = max(0.0, second - stale_s)
        return to_odds(outcome_probabilities(m.home_rate, m.away_rate, m.score_at(seen_at, known_only=True), seen_at / 60))

    def guard_open(self, m: Match, second: float) -> bool:
        last = m.last_known_goal(second)
        return last is None or second - last >= GUARD_COOLDOWN_S + 5  # +5 s: odds refresh after the cooldown

    # ── building stored records ──
    def _selection(self, m: Match, pick: str, odd: float, live_second: float | None = None, odds_age_s: float = 2.0) -> dict:
        sel = {"matchId": m.id, "betId": PREMATCH_BET_ID, "pick": pick, "odd": odd, "result": "won" if m.result() == pick else "lost"}
        if live_second is not None:
            known = m.score_at(live_second, known_only=True)
            last = m.last_known_goal(live_second)
            sel.update(
                betId=LIVE_BET_ID,
                live=True,
                context={
                    "minute": int(live_second // 60),
                    "score": {"home": known[0], "away": known[1]},
                    "feedAgeMs": int(self.rng.uniform(500, 5000)),
                    "oddsAgeMs": int(odds_age_s * 1000),
                    "msSinceIncident": int((live_second - last) * 1000) if last is not None else None,
                    "lastIncident": "goal" if last is not None else None,
                },
                goals=m.goal_timeline(),
            )
        return sel

    def _add_bet(self, user: str, sels: list[dict], stake: float, at: pd.Timestamp) -> None:
        self._bet_seq += 1
        status = "won" if all(s["result"] == "won" for s in sels) else "lost"
        self.bets.append({
            "bet_id": f"SIM{self._bet_seq:06d}",
            "user_id": user,
            "created_at": at,
            "stake": round(stake, 2),
            "mode": "combined",
            "status": status,
            "selections": sels,
        })

    def _random_match(self) -> Match:
        return self.matches[int(self.rng.integers(len(self.matches)))]

    def _stake(self, median: float) -> float:
        return float(np.clip(self.rng.lognormal(np.log(median), 0.6), 5, 50_000))

    # ── honest users ──
    def recreational(self, user: str, skilled: bool = False) -> None:
        self.labels[user] = "skilled" if skilled else "recreational"
        median_stake = float(self.rng.uniform(10, 60))
        for _ in range(int(self.rng.poisson(30)) + 8):
            if self.rng.random() < 0.2:
                self._honest_live_bet(user, median_stake, skilled)
                continue
            legs = 1 if skilled or self.rng.random() < 0.5 else int(self.rng.integers(2, 4))
            sels = []
            picked = [self._random_match() for _ in range(legs)]
            for m in {m.id: m for m in picked}.values():  # one leg per match
                odds = self.prematch_odds(m)
                if skilled:
                    pick = self._value_pick(m, odds, edge=0.04)
                else:
                    weights = np.array([1 / odds[p] for p in PICKS]) ** 1.3  # leans towards favourites
                    pick = PICKS[int(self.rng.choice(3, p=weights / weights.sum()))]
                sels.append(self._selection(m, pick, odds[pick]))
            at = min(self.matches_by_id(s["matchId"]).kickoff for s in sels) - pd.Timedelta(hours=float(self.rng.uniform(0.5, 30)))
            self._add_bet(user, sels, self._stake(median_stake), at)

    def _value_pick(self, m: Match, odds: dict[str, float], edge: float) -> str:
        """A skilled bettor's private estimate is slightly better than the market: they back the
        outcome where their (noisy but informed) view beats the price by the most."""
        true = outcome_probabilities(m.home_rate, m.away_rate)
        if self.rng.random() < 0.3:  # sometimes their homework points the right way
            true = {p: v + (edge if p == m.result() else -edge / 2) for p, v in true.items()}
        return max(PICKS, key=lambda p: true[p] * odds[p])

    def _honest_live_bet(self, user: str, median_stake: float, skilled: bool) -> None:
        m = self._random_match()
        for _ in range(10):  # an honest bettor bets whenever the market is open
            second = float(self.rng.uniform(5 * 60, 85 * 60))
            if self.guard_open(m, second):
                break
        else:
            return
        odds = self.live_odds(m, second)
        if skilled:
            pick = self._value_pick(m, odds, edge=0.05)
        else:
            weights = np.array([1 / odds[p] for p in PICKS]) ** 1.3
            pick = PICKS[int(self.rng.choice(3, p=weights / weights.sum()))]
        at = m.kickoff + pd.Timedelta(seconds=second)
        self._add_bet(user, [self._selection(m, pick, odds[pick], live_second=second, odds_age_s=float(self.rng.uniform(0.5, 8)))], self._stake(median_stake), at)

    # ── cheaters ──
    def past_poster(self, user: str) -> None:
        self.labels[user] = "past_poster"
        median_stake = float(self.rng.uniform(40, 150))
        with_goals = [m for m in self.matches if m.goals]
        for _ in range(int(self.rng.poisson(14)) + 6):
            m = with_goals[int(self.rng.integers(len(with_goals)))]
            g = int(self.rng.integers(len(m.goals)))
            (t_goal, side), lag = m.goals[g], m.feed_lag[g]
            pick = "Home" if side == "home" else "Away"
            # They saw the goal on TV; the server learns of it `lag` seconds later. Fast enough →
            # the bet goes through at the pre-goal price. Too slow → the guard refuses it.
            for attempt in range(int(self.rng.integers(1, 3))):
                second = t_goal + float(self.rng.uniform(1, lag + 12))
                if second < t_goal + lag or self.guard_open(m, second):
                    odds = self.live_odds(m, second)
                    at = m.kickoff + pd.Timedelta(seconds=second)
                    self._add_bet(user, [self._selection(m, pick, odds[pick], live_second=second, odds_age_s=float(self.rng.uniform(2, 9)))], self._stake(median_stake), at)
                    break
                self.events.append({"user_id": user, "fixture_id": m.id, "rule": "incident_cooldown", "created_at": m.kickoff + pd.Timedelta(seconds=second)})
        for _ in range(int(self.rng.poisson(6))):  # some ordinary bets as cover
            self._honest_live_bet(user, median_stake / 3, skilled=False)

    def glitch_sniper(self, user: str) -> None:
        self.labels[user] = "glitch_sniper"
        median_stake = float(self.rng.uniform(30, 120))
        for _ in range(int(self.rng.poisson(16)) + 6):
            m = self._random_match()
            fair = self.prematch_odds(m)
            # A feed error inflates one outcome's price for a few seconds; the sniper takes it.
            pick = PICKS[int(self.rng.integers(3))]
            glitched = round(fair[pick] * float(self.rng.uniform(1.8, 3.0)), 2)
            at = m.kickoff - pd.Timedelta(hours=float(self.rng.uniform(1, 20)))
            self._add_bet(user, [self._selection(m, pick, glitched)], self._stake(median_stake), at)
        for _ in range(int(self.rng.poisson(5))):
            self.recreational_bet(user, median_stake / 2)

    def insider(self, user: str) -> None:
        self.labels[user] = "insider"
        median_stake = float(self.rng.uniform(80, 300))
        for _ in range(int(self.rng.poisson(10)) + 6):
            m = self._random_match()
            odds = self.prematch_odds(m)
            # Knows the result 60% of the time; otherwise guesses. Only bets prices of 3.0+.
            pick = m.result() if self.rng.random() < 0.6 else PICKS[int(self.rng.integers(3))]
            if odds[pick] < 3.0:
                continue
            self._add_bet(user, [self._selection(m, pick, odds[pick])], self._stake(median_stake), m.kickoff - pd.Timedelta(hours=float(self.rng.uniform(1, 6))))
        for _ in range(int(self.rng.poisson(8))):
            self.recreational_bet(user, median_stake / 4)

    def recreational_bet(self, user: str, median_stake: float) -> None:
        m = self._random_match()
        odds = self.prematch_odds(m)
        pick = PICKS[int(self.rng.integers(3))]
        self._add_bet(user, [self._selection(m, pick, odds[pick])], self._stake(median_stake), m.kickoff - pd.Timedelta(hours=2))

    def ring(self, users: list[str]) -> None:
        """Accounts run by one person: the same slips, placed minutes apart, near-maximum stakes."""
        for u in users:
            self.labels[u] = "ring"
        for _ in range(int(self.rng.poisson(15)) + 8):
            legs = int(self.rng.integers(1, 4))
            chosen = [self._random_match() for _ in range(legs)]
            picks = []
            for m in chosen:
                odds = self.prematch_odds(m)
                pick = PICKS[int(self.rng.integers(3))]
                picks.append((m, pick, odds[pick]))
            first = min(m.kickoff for m, _, _ in picks) - pd.Timedelta(hours=float(self.rng.uniform(1, 12)))
            for u in users:
                if self.rng.random() < 0.15:
                    continue
                at = first + pd.Timedelta(seconds=float(self.rng.uniform(0, 300)))
                self._add_bet(u, [self._selection(m, p, o) for m, p, o in picks], float(self.rng.uniform(400, 1000)), at)

    def matches_by_id(self, match_id: int) -> Match:
        return self.matches[match_id - 100_000]

    # ── the whole platform ──
    def run(self, n_recreational=300, n_skilled=15, n_past_posters=6, n_snipers=5, n_insiders=4, rings=((4,), (3,))) -> "SyntheticData":
        uid = iter(range(1, 10_000))
        for _ in range(n_recreational):
            self.recreational(f"user{next(uid):04d}")
        for _ in range(n_skilled):
            self.recreational(f"user{next(uid):04d}", skilled=True)
        for _ in range(n_past_posters):
            self.past_poster(f"user{next(uid):04d}")
        for _ in range(n_snipers):
            self.glitch_sniper(f"user{next(uid):04d}")
        for _ in range(n_insiders):
            self.insider(f"user{next(uid):04d}")
        for (size,) in rings:
            self.ring([f"user{next(uid):04d}" for _ in range(size)])
        bets = pd.DataFrame(self.bets).sort_values("created_at").reset_index(drop=True)
        events = pd.DataFrame(self.events, columns=["user_id", "fixture_id", "rule", "created_at"])
        return SyntheticData(bets=bets, events=events, labels=self.labels)


@dataclass
class SyntheticData:
    bets: pd.DataFrame
    events: pd.DataFrame
    labels: dict[str, str]

    @property
    def is_abuser(self) -> pd.Series:
        return pd.Series({u: kind in ABUSE_KINDS for u, kind in self.labels.items()})


def generate(seed: int = 7, **kwargs) -> SyntheticData:
    return Simulator(seed=seed).run(**kwargs)


__all__ = ["generate", "SyntheticData", "Simulator", "implied_probability"]
