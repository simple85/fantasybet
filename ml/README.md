# Betting-integrity detection

Finds users whose betting looks like abuse, from what FantasyBet already stores. It runs as a batch job next to the Node server and writes its results to the `integrity_flags` table, which the admin panel shows under **Integrity review**.

It covers four patterns:

- **Past-posting:** betting on goals the feed hasn't reported yet.
- **Odds-glitch hunting:** betting on prices far above what everyone else got.
- **Multi-accounting rings:** several accounts placing the same slips within minutes.
- **Anything else unusual:** caught by an unsupervised anomaly model.

The real-time half lives in the Node server (`integrity.js`). It refuses live bets right after goals and red cards, refuses them while the odds feed lags, and stores a timing snapshot with every live bet.

## How it works

```text
bets + integrity_events (PostgreSQL)
        │
        ▼
features.py   per-user signals: luck z-score, live luck, past-posting rate, price outliers,
              pair overlap with one other account, refused attempts, live share, ROI
        │
        ├──► rules.py   explicit patterns (past_posting, shared_slips, odds_glitch_hunting, …)
        └──► model.py   Isolation Forest on robust-scaled features → anomaly percentile
                │
                ▼
        review list: rule hits + the most anomalous users the rules missed,
        each with plain-language reasons → integrity_flags
```

## Evaluation

There are no labelled cheaters on a small site, so `synthetic.py` simulates a platform: Poisson-priced matches, feed delay, the live guard, honest and skilled bettors, and planted cheaters. One cheater type (**insider**) has no rule on purpose, to test whether the system finds patterns nobody wrote a rule for.

`python -m integrity evaluate` compares four approaches over 5 simulated platforms and writes [`reports/evaluation.md`](reports/evaluation.md). In short:

| | Naive "wins too much" | Combined (rules + anomaly) |
|---|---|---|
| Cheaters flagged | 20% | 93% |
| Share of flags that are cheaters | 40% | 74% |
| Insiders flagged (no rule exists for them) | 15% | 60% |
| Honest skilled bettors flagged (of 15) | 5.2 | 2.6 |

## Usage

```bash
cd ml
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m integrity demo                    # review list for a simulated platform
.venv/bin/python -m integrity evaluate                # writes reports/evaluation.md
DATABASE_URL=postgres://… .venv/bin/python -m integrity score --dry-run   # real data, print only
DATABASE_URL=postgres://… .venv/bin/python -m integrity score             # store a run for the admin panel
.venv/bin/pytest -q
```

On Railway, `python -m integrity score` can run as a scheduled (cron) service with the same `DATABASE_URL`.
