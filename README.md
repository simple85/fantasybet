# FantasyBet

Fantasy football betting website built as a portfolio project. Users place bets on real football matches using virtual credits. Odds are pulled from the API-Football (Bet365) feed, and bets are settled automatically based on match results.

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

## Data Refresh Schedule

| Time | Action | Est. Daily API Calls |
|------|--------|----------------------|
| 00:00, 12:00 | Full fixture + odds refresh | ~12 |
| 04:00, 08:00, 16:00, 20:00 | Odds update only | ~30 |
| Every hour (:30) | Finished match scores | ~10 |
| **Total** | | **~50/day** |

The free plan allows 100 requests/day, which is more than enough.

## Demo Users

Users are stored in PostgreSQL and managed through the admin panel. Below are the default demo accounts:

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
- Username: `admin`
- Password: stored in `.env` (`ADMIN_ID`, `ADMIN_PASSWORD`)

Used for managing users and adding credits.

## Project Structure

```
fantasybet/
├── .env                    # API key and admin credentials (not committed)
├── .env.example            # Template
├── .gitignore
├── package.json
├── server.js               # Express server, scheduler, settlement engine
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

## Deployment

Works on any Node.js hosting platform.

1. **Railway** (recommended):
   - Connect your repo
   - Add a PostgreSQL plugin
   - Set `API_FOOTBALL_KEY`, `ADMIN_ID`, `ADMIN_PASSWORD` as environment variables
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

- No real money is involved. This is a portfolio project.
- Users start with 0 credits. Credits are granted by an admin.
- The API key stays server-side and is never exposed to the frontend.
- Supports three languages: Turkish, English, German.
- Bets are settled automatically using match events, statistics, and scores from the API.
