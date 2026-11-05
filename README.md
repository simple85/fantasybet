# FantasyBet

[![CI](https://github.com/simple85/fantasybet/actions/workflows/ci.yml/badge.svg)](https://github.com/simple85/fantasybet/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Tested with Jest](https://img.shields.io/badge/tested%20with-Jest-C21325?logo=jest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Fantasy football betting website built as a portfolio project. Users place bets on real football matches using virtual credits. Odds are pulled from the API-Football (Bet365) feed, and bets are settled automatically based on match results.

> No real money is involved. Credits are virtual and granted by an admin.

## Features

- **Live in-play odds** pushed to the browser over Server-Sent Events (no polling)
- **Pre-match odds** for 30+ Bet365 markets, refreshed every 2 hours
- **Combined and system bets**, priced by the server from its own odds (a stale price gets an "odds changed" answer, never the user's number)
- **Betting integrity**: live markets pause right after goals and red cards and while the odds feed lags, and a Python anomaly model flags past-posting, odds-glitch hunting and multi-account rings for admin review ([how it works](#betting-integrity))
- **AI bet builder**: describe a bet in Turkish, English or German and get a server-priced slip to add ([how it works](#ai-bet-builder))
- **Automatic settlement engine** for 1X2, over/under, BTTS, Asian & European handicap, half-time and HT/FT, correct score, goal scorers, goal intervals, corners, cards and shots
- **Transactional credit handling** in PostgreSQL
- **Secure sessions**: scrypt-hashed passwords and HMAC-signed `HttpOnly` cookies; admin endpoints and personal data are protected server-side
- **Admin panel** for managing users and credits, and reviewing integrity flags
- **Three languages**: Turkish, English, German

## Tech Stack

| Area | Tools |
|------|-------|
| Backend | Node.js, Express, Server-Sent Events |
| Database | PostgreSQL (`pg`) |
| Data | API-Football v3 |
| Frontend | Vanilla JS, HTML, CSS |
| Integrity model | Python, pandas, scikit-learn (Isolation Forest), pytest |
| AI | Gemini API (`@google/genai`, function calling) |
| Testing | Jest, Supertest, pytest |
| CI | GitHub Actions (Node 20 & 22, Python 3.12) |
| Hosting | Railway |

## Setup

```bash
npm install

# Copy the env template and add your API key
cp .env.example .env

# Start the server
npm start
```

Open `http://localhost:8000` in your browser.

The site works without an API key — it starts with mock data and switches to live data once the key is configured.

## API Key

1. Create a free account at https://dashboard.api-football.com/
2. Copy your API key
3. Paste it into `.env`:
   ```
   API_FOOTBALL_KEY=your_key_here
   ```

The `.env` file is protected by `.gitignore` and will never be pushed to the repository.

## Data Refresh Schedule

| Time | Action | Est. Daily API Calls |
|------|--------|----------------------|
| 00:00, 12:00 | Full fixture + odds refresh | ~12 |
| 04:00, 08:00, 16:00, 20:00 | Odds update only | ~30 |
| Every hour (:30) | Finished match scores | ~10 |
| **Total** | | **~50/day** |

The free plan allows 100 requests/day, which is more than enough.

## Demo Users

Users are stored in PostgreSQL and managed through the admin panel. A fresh database is seeded with these **demo-only** accounts for local testing:

| Username | Password | Display Name |
|----------|----------|--------------|
| ali | ali123 | Ali Yilmaz |
| max | max123 | Max Richter |
| james | james123 | James Cole |
| emre | emre123 | Emre Celik |
| lena | lena123 | Lena Weber |

New users can be added via the admin panel at `/admin.html`.

## Admin Panel

- URL: `/admin.html`
- Username and password come from `.env` (`ADMIN_ID`, `ADMIN_PASSWORD`). Admin login stays disabled until `ADMIN_PASSWORD` is set.

Used for managing users and adding credits.

## Project Structure

```
fantasybet/
├── .env                    # API key and admin credentials (not committed)
├── .env.example            # Template
├── .gitignore
├── package.json
├── __tests__/              # Jest + Supertest test suites
├── server.js               # Express server, scheduler, settlement engine
├── auth.js                 # password hashing, session cookies, route guards
├── pricing.js              # server-side odds lookup for every selection
├── integrity.js            # real-time guard against past-posting on live bets
├── betBuilder.js           # AI bet builder (Gemini function calling)
├── evals/                  # live evals for the bet builder (needs GEMINI_API_KEY)
├── ml/                     # Python integrity model (see ml/README.md)
├── fetch-data.js           # API-Football data fetcher
├── db.js                   # PostgreSQL connection pool and queries
├── public/
│   ├── index.html          # Login page
│   ├── app.html            # Main betting page
│   ├── admin.html          # Admin panel
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── config.js       # League priorities and bet category definitions
│       ├── i18n.js         # Translations (TR/EN/DE)
│       └── matches.js      # Data loader (API + mock fallback)
└── README.md
```

## CLI Commands

```bash
# Check API account status
node fetch-data.js --status

# Fetch fixtures (yesterday to day-after-tomorrow)
node fetch-data.js --fixtures

# Fetch live odds
node fetch-data.js --live-odds

# Fetch live fixture statuses
node fetch-data.js --live-fixtures
```

## Testing

```bash
npm test                 # run all tests
npm run test:coverage    # with coverage report (coverage/lcov-report/index.html)
```

| Suite | What it covers |
|-------|----------------|
| `evaluateSelection.test.js` | Settlement rules for every market type, ID-based (pre-match) and name-based (live) |
| `computeBetOutcome.test.js` | Payout math for combined and system bets, void handling, rounding |
| `auth.test.js` | Password hashing, legacy-password upgrade, signed session tokens (tampering, expiry, wrong secret) |
| `api.test.js` | REST endpoints via Supertest: login/logout, admin-only and owner-only access (401/403), credits, server-side pricing and "odds changed", the live integrity guard, settlement flow |
| `integrity.test.js` | Goal and red-card detection, guard rules, red-card counting from live events |
| `betBuilder.test.js` | Bet-builder tools (search without accents, live odds, server pricing, guard), the agent loop with a scripted model, the API (limits, validation) |
| `ml/tests` (pytest) | Football maths, features, past-posting rule, the scoring model end to end |

The database layer is mocked with `jest.mock`, so tests run without PostgreSQL or an API key.

## Betting integrity

**At bet time (`integrity.js`).** The server learns about goals from the 15-second score feed and gets odds from the 5-second odds feed. In between, a bettor watching TV can know about a goal before our prices do. That's "past-posting". A live bet is refused when any of these holds:

- the odds feed is more than 20 s old;
- a goal or red card happened in the last 30 s;
- the match's odds haven't changed since that goal or card.

When the score feed reports a goal, the match's live odds are suspended immediately. Every refused attempt is logged. Every accepted live selection stores a snapshot: minute, score as known, odds age and time since the last incident.

**After the fact (`ml/`).** A Python job reads settled bets and refused attempts and computes per-user signals:

- **luck z-score:** wins above what the odds imply;
- **past-posting footprint:** bets placed while a goal had happened but wasn't in our score yet;
- **price outliers:** odds far above what everyone else got;
- **pair overlap:** identical slips with one other account;
- **refused attempts.**

Explicit rules and an Isolation Forest turn these into a review list with plain-language reasons, which the admin panel shows. It's evaluated on simulated platforms with planted cheaters, including a type no rule was written for (see [`ml/README.md`](ml/README.md) and [`ml/reports/evaluation.md`](ml/reports/evaluation.md)). Flags are for human review, never automatic bans.

## AI bet builder

Users type a bet ("Galatasaray kazanır ve 2.5 üst, 20 kredi") in the bet slip. `betBuilder.js` runs Gemini with three tools: `find_matches`, `list_markets` and `propose_slip`. The model only reads the server's own data. `propose_slip` prices every selection with `pricing.js` and checks live ones with `integrity.js`, just like placing a bet. The user gets a card to **add to the slip** and places the bet themselves; the assistant can't place bets.

Other safeguards:
- **No tips:** it won't give predictions.
- **Limits:** a daily limit per user (`BET_BUILDER_DAILY_LIMIT`, default 40 calls); input is validated; requests time out after 30 s.
- **Tracking:** each model call is logged to `bet_builder_usage` with tokens, cost and latency.
- **Model:** `gemini-3.6-flash` by default (`BET_BUILDER_MODEL`).

Live evals with real requests: `GEMINI_API_KEY=… npm run eval:bet-builder`.

## Deployment

Works on any Node.js hosting platform. Currently deployed on Railway with a PostgreSQL add-on.

1. **Railway** (recommended):
   - Connect your repo
   - Add a PostgreSQL plugin
   - Set `API_FOOTBALL_KEY`, `ADMIN_ID`, `ADMIN_PASSWORD`, `SESSION_SECRET` and (for the bet builder) `GEMINI_API_KEY` as environment variables
   - Optional: a scheduled service running `cd ml && pip install . && python -m integrity score` for the integrity review
   - The `DATABASE_URL` is injected automatically by Railway
   - Start command: `npm start`

2. **VPS**:
   ```bash
   git clone <repo>
   cd fantasybet
   npm install
   cp .env.example .env   # fill in your keys
   npm start
   ```
   Use PM2 for background: `pm2 start server.js --name fantasybet`

## Notes

- Users start with 0 credits. Credits are granted by an admin.
- Passwords are stored as scrypt hashes. Accounts from older versions with plaintext passwords are re-hashed automatically on their next login.
- Bets are always placed for the logged-in user. Stake, total odds and payout are recalculated on the server.
- The API key stays server-side and is never exposed to the frontend.
- Supports three languages: Turkish, English, German.
- Bets are settled automatically using match events, statistics, and scores from the API.

## License

Released under the [MIT License](LICENSE).
