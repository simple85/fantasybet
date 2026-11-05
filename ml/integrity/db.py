"""Reading bets from and writing flags to FantasyBet's PostgreSQL (the tables db.js creates)."""

from __future__ import annotations

import json
import uuid

import pandas as pd
import psycopg

from .model import ScoringResult


def load(database_url: str, days: int = 90) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Settled bets and refused live attempts from the last `days` days."""
    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, user_id, created_at, stake, mode, status, selections FROM bets
               WHERE status IN ('won', 'lost') AND created_at > NOW() - make_interval(days => %s)""",
            (days,),
        )
        bets = pd.DataFrame(cur.fetchall(), columns=["bet_id", "user_id", "created_at", "stake", "mode", "status", "selections"])
        cur.execute(
            "SELECT user_id, fixture_id, rule, created_at FROM integrity_events WHERE created_at > NOW() - make_interval(days => %s)",
            (days,),
        )
        events = pd.DataFrame(cur.fetchall(), columns=["user_id", "fixture_id", "rule", "created_at"])
    bets["stake"] = bets["stake"].astype(float)
    return bets, events


def write_flags(database_url: str, result: ScoringResult, features: pd.DataFrame) -> str:
    """Stores one row per scored user under a new run id; the admin panel shows the latest run."""
    run_id = uuid.uuid4().hex[:12]
    rows = [
        (
            run_id,
            user,
            float(r["score"]),
            bool(r["flagged"]),
            json.dumps({"rules": r["rules"], "text": r["reasons"]}),
            json.dumps({k: (round(float(v), 4) if isinstance(v, float) else int(v)) for k, v in features.loc[user].items()}),
        )
        for user, r in result.scores.iterrows()
    ]
    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO integrity_flags (run_id, user_id, score, flagged, reasons, features) VALUES (%s, %s, %s, %s, %s, %s)",
            rows,
        )
    return run_id
