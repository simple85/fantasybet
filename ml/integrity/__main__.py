"""Command line:

    python -m integrity demo                    score a synthetic platform and print the review list
    python -m integrity evaluate                compare the approaches, write reports/evaluation.md
    python -m integrity score [--dry-run]       score the real database (DATABASE_URL) and store flags
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pandas as pd

from .features import user_features
from .model import score_users


def print_review_list(scores: pd.DataFrame, labels: dict | None = None) -> None:
    flagged = scores[scores["flagged"]]
    print(f"{len(flagged)} of {len(scores)} users flagged for review\n")
    for user, r in flagged.iterrows():
        kind = f"  [{labels[user]}]" if labels else ""
        print(f"{user}  score {r['score']:.2f}{kind}")
        for reason in r["reasons"]:
            print(f"    - {reason}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m integrity")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="score a synthetic platform")
    demo.add_argument("--seed", type=int, default=7)
    ev = sub.add_parser("evaluate", help="evaluate on synthetic platforms")
    ev.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3, 4, 5])
    ev.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "reports" / "evaluation.md"))
    sc = sub.add_parser("score", help="score the real database")
    sc.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    sc.add_argument("--days", type=int, default=90)
    sc.add_argument("--dry-run", action="store_true", help="print the review list without storing it")
    args = parser.parse_args(argv)

    if args.command == "demo":
        from .synthetic import generate

        data = generate(seed=args.seed)
        features = user_features(data.bets, data.events)
        print_review_list(score_users(features).scores, data.labels)
        return 0

    if args.command == "evaluate":
        from .evaluate import report

        text = report(tuple(args.seeds))
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text)
        print(text)
        return 0

    if not args.database_url:
        print("Set DATABASE_URL or pass --database-url", file=sys.stderr)
        return 2
    from .db import load, write_flags

    bets, events = load(args.database_url, args.days)
    if bets.empty:
        print("No settled bets in the period; nothing to score.")
        return 0
    features = user_features(bets, events)
    result = score_users(features)
    print_review_list(result.scores)
    if not args.dry_run:
        print(f"\nStored as run {write_flags(args.database_url, result, features)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
