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
- **Combined and system bets**, with suspended and stale odds rejected server-side
- **Automatic settlement engine** for 1X2, over/under, BTTS, Asian & European handicap, half-time and HT/FT, correct score, goal scorers, goal intervals, corners, cards and shots
- **Transactional credit handling** in PostgreSQL
- **Secure sessions**: scrypt-hashed passwords and HMAC-signed `HttpOnly` cookies; admin endpoints and personal data are protected server-side
- **Admin panel** for managing users and credits
- **Three languages**: Turkish, English, German

## Tech Stack

| Area | Tools |
|------|-------|
| Backend | Node.js, Express, Server-Sent Events |
| Database | PostgreSQL (`pg`) |
| Data | API-Football v3 |
| Frontend | Vanilla JS, HTML, CSS |
| Testing | Jest, Supertest |
| CI | GitHub Actions (Node 20 & 22) |
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
| `api.test.js` | REST endpoints via Supertest: login/logout, admin-only and owner-only access (401/403), credits, server-side stake and payout checks, settlement flow |

The database layer is mocked with `jest.mock`, so tests run without PostgreSQL or an API key.

## Deployment

Works on any Node.js hosting platform. Currently deployed on Railway with a PostgreSQL add-on.

1. **Railway** (recommended):
   - Connect your repo
   - Add a PostgreSQL plugin
   - Set `API_FOOTBALL_KEY`, `ADMIN_ID`, `ADMIN_PASSWORD` and `SESSION_SECRET` as environment variables
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
