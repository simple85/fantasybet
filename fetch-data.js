// ============================================
// API-FOOTBALL DATA FETCHER (v3)
// ============================================
// Uses https://v3.football.api-sports.io
//
// Flow:
//   1. GET /fixtures?date=YYYY-MM-DD  → fixture IDs, league info, teams + logos, status
//   2. GET /odds?fixture=X&bookmaker=8 → Bet365 odds for each fixture
//   3. Combine & save to data/matches.json
//
// Schedules (managed by server.js):
//   - Full refresh (fixtures + odds): every 4h (00, 04, 08, 12, 16, 20)
//   - Odds update (24h fixtures):     every 5 minutes
//   - Odds update (other fixtures):   every 15 minutes
//
// Run standalone:
//   node fetch-data.js --once      Full refresh
//   node fetch-data.js --odds24    Odds for 24h fixtures
//   node fetch-data.js --oddsext   Odds for extended fixtures
//   node fetch-data.js --status    Check API status

const https = require("https");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const API_KEY = process.env.API_FOOTBALL_KEY;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "matches.json");

// ── Allowed bet IDs (whitelist) ──
const ALLOWED_BET_IDS = new Set([
  1,   // Match Winner
  2,   // Home/Away
  3,   // Second Half Winner
  4,   // Asian Handicap
  5,   // Goals Over/Under
  6,   // Goals Over/Under First Half
  7,   // HT/FT Double
  8,   // Both Teams Score
  10,  // Exact Score
  12,  // Double Chance
  13,  // First Half Winner
  14,  // Team To Score First
  15,  // Team To Score Last
  16,  // Total - Exact Goals
  17,  // Home Team Total Goals
  18,  // Away Team Total Goals
  19,  // Asian Handicap First Half
  20,  // Double Chance - First Half
  21,  // Odd/Even
  22,  // Odd/Even - First Half
  25,  // Both Teams Score - First Half
  26,  // Both Teams Score - Second Half
  29,  // Result/Total Goals First Half
  31,  // Correct Score - First Half
  34,  // First Goal Scorer
  35,  // Last Goal Scorer
  36,  // Anytime Goal Scorer
  37,  // Home Goal Scorers
  38,  // Away Goal Scorers
  39,  // Player Assists
  40,  // Player Fouls
  42,  // First Card
  43,  // Cards Over/Under
  44,  // Home Total Cards
  45,  // Corners Over/Under
  46,  // Away Total Cards
  47,  // Home Corners
  48,  // Away Corners
  49,  // Corners First Half
  50,  // Goal Line
  51,  // European Handicap
  52,  // Home Odd/Even
  53,  // Away Odd/Even
  55,  // Goals Over/Under Second Half
  63,  // Odd/Even - Second Half
  72,  // Goal Line (1st Half)
  77,  // Total Corners (1st Half)
  85,  // Total Corners (3 way)
  86,  // Cards European Handicap
  87,  // Handicap 1st Half (European)
]);

const BET365_ID = 8;

// ── Concurrency lock ──
let _busy = false;

// ── API Request ──
function apiRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const reqPath = `/${endpoint}${query ? "?" + query : ""}`;

    console.log(`  -> GET ${reqPath}`);

    const options = {
      method: "GET",
      hostname: "v3.football.api-sports.io",
      path: reqPath,
      headers: { "x-apisports-key": API_KEY },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const remaining = res.headers["x-ratelimit-requests-remaining"];
        const limit = res.headers["x-ratelimit-requests-limit"];
        if (remaining) console.log(`  Requests remaining: ${remaining}/${limit}`);

        try {
          const data = JSON.parse(body);
          if (data.errors && Object.keys(data.errors).length > 0) {
            console.error("  API errors:", JSON.stringify(data.errors));
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
            return;
          }
          resolve(data);
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Check API status ──
async function checkStatus() {
  console.log("\nChecking API status...");
  try {
    const data = await apiRequest("status");
    console.log("  Account:", JSON.stringify(data));
    return data;
  } catch (err) {
    console.error("  Status check failed:", err.message);
    return null;
  }
}

// ── Fetch all fixtures for a given date ──
async function fetchFixturesByDate(date) {
  console.log(`\nFetching fixtures for ${date}...`);
  const data = await apiRequest("fixtures", { date });
  const fixtures = data.response || [];

  const results = fixtures.map(item => ({
    id: item.fixture.id,
    date: item.fixture.date,
    status: item.fixture.status.long,
    league: {
      id: item.league.id,
      name: item.league.name,
      country: item.league.country,
      logo: item.league.logo,
      flag: item.league.flag,
    },
    home: {
      id: item.teams.home.id,
      name: item.teams.home.name,
      logo: item.teams.home.logo,
    },
    away: {
      id: item.teams.away.id,
      name: item.teams.away.name,
      logo: item.teams.away.logo,
    },
    score: item.goals.home !== null ? { home: item.goals.home, away: item.goals.away } : null,
    bets: [],
  }));

  console.log(`  Found ${results.length} fixtures`);
  return results;
}

// ── Fetch Bet365 odds for a single fixture ──
async function fetchOddsForFixture(fixtureId) {
  try {
    const data = await apiRequest("odds", { fixture: fixtureId, bookmaker: BET365_ID });
    const items = data.response || [];

    for (const item of items) {
      const bet365 = item.bookmakers?.find(b => b.id === BET365_ID);
      if (bet365) {
        return bet365.bets.filter(b => ALLOWED_BET_IDS.has(b.id));
      }
    }
  } catch (err) {
    console.error(`  FAIL odds fixture ${fixtureId}: ${err.message}`);
  }
  return [];
}

// ── Utils ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function saveData(matches) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = { lastUpdated: new Date().toISOString(), matchCount: matches.length, matches };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`\nSaved ${matches.length} matches to data/matches.json`);
}

function loadExistingData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      return data.matches || [];
    }
  } catch (e) {}
  return [];
}

// ── Finished status check ──
const FINISHED_STATUSES = new Set([
  "Match Finished", "After Extra Time", "After Penalty",
  "Match Postponed", "Match Cancelled", "Match Abandoned",
]);

// ── MAIN TASKS ──

/**
 * Full refresh: fetch fixtures for today + next 3 days, then fetch Bet365 odds for each.
 * Runs every 4 hours (00:00, 04:00, 08:00, 12:00, 16:00, 20:00).
 */
async function fullRefresh() {
  if (_busy) { console.log("[SKIP] Another task is running"); return; }
  _busy = true;

  console.log("\n" + "=".repeat(50));
  console.log("FULL REFRESH — Fixtures + Odds (4 days)");
  console.log("=".repeat(50));

  if (!API_KEY || API_KEY.length < 5) {
    console.log("No API key configured. Skipping fetch.");
    _busy = false;
    return;
  }

  try {
    const today = new Date();
    const dates = [];
    for (let i = 0; i < 4; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      dates.push(formatDate(d));
    }

    // Step 1: Fetch fixtures for all 4 days
    let allFixtures = [];
    for (const date of dates) {
      const fixtures = await fetchFixturesByDate(date);
      allFixtures = allFixtures.concat(fixtures);
      await sleep(400);
    }

    console.log(`\nTotal fixtures across ${dates.length} days: ${allFixtures.length}`);

    // Step 2: Fetch Bet365 odds for each fixture (skip finished)
    const toFetchOdds = allFixtures.filter(f => !FINISHED_STATUSES.has(f.status));
    console.log(`\nFetching Bet365 odds for ${toFetchOdds.length} non-finished fixtures...`);

    let oddsCount = 0;
    for (let i = 0; i < toFetchOdds.length; i++) {
      const fixture = toFetchOdds[i];
      const bets = await fetchOddsForFixture(fixture.id);
      if (bets.length > 0) {
        fixture.bets = bets;
        oddsCount++;
      }
      if ((i + 1) % 50 === 0) {
        console.log(`  Progress: ${i + 1}/${toFetchOdds.length} (${oddsCount} with odds)`);
      }
      await sleep(350);
    }

    console.log(`\nOdds found for ${oddsCount}/${toFetchOdds.length} fixtures`);

    saveData(allFixtures);
    console.log("Full refresh complete");
  } catch (err) {
    console.error("\nFull refresh failed:", err.message);
  }

  _busy = false;
}

/**
 * Odds update for fixtures within 24 hours.
 * Runs every 5 minutes.
 */
async function oddsUpdate24h() {
  if (_busy) { console.log("[SKIP] Another task is running"); return; }
  _busy = true;

  console.log("\n" + "=".repeat(50));
  console.log("ODDS UPDATE — 24h fixtures (every 5 min)");
  console.log("=".repeat(50));

  if (!API_KEY || API_KEY.length < 5) { console.log("No API key. Skipping."); _busy = false; return; }

  try {
    const existing = loadExistingData();
    if (existing.length === 0) {
      console.log("No cached data, running full refresh...");
      _busy = false;
      return fullRefresh();
    }

    const now = Date.now();
    const cutoff24h = now + 24 * 3600 * 1000;

    // Fixtures within next 24h or recently started (up to 6h ago), excluding finished
    const targets = existing.filter(m => {
      if (FINISHED_STATUSES.has(m.status)) return false;
      const d = new Date(m.date).getTime();
      return d <= cutoff24h && d >= now - 6 * 3600 * 1000;
    });

    if (targets.length === 0) {
      console.log("No eligible fixtures within 24h window.");
      _busy = false;
      return;
    }

    console.log(`  Updating odds for ${targets.length} fixtures (within 24h)...`);
    let updated = 0;
    for (const match of targets) {
      const bets = await fetchOddsForFixture(match.id);
      if (bets.length > 0) {
        match.bets = bets;
        updated++;
      }
      await sleep(350);
    }

    saveData(existing);
    console.log(`Odds updated for ${updated}/${targets.length} fixtures`);
  } catch (err) {
    console.error("\nOdds update (24h) failed:", err.message);
  }

  _busy = false;
}

/**
 * Odds update for fixtures beyond 24 hours.
 * Runs every 15 minutes.
 */
async function oddsUpdateExtended() {
  if (_busy) { console.log("[SKIP] Another task is running"); return; }
  _busy = true;

  console.log("\n" + "=".repeat(50));
  console.log("ODDS UPDATE — Extended fixtures (every 15 min)");
  console.log("=".repeat(50));

  if (!API_KEY || API_KEY.length < 5) { console.log("No API key. Skipping."); _busy = false; return; }

  try {
    const existing = loadExistingData();
    if (existing.length === 0) {
      console.log("No cached data.");
      _busy = false;
      return;
    }

    const now = Date.now();
    const cutoff24h = now + 24 * 3600 * 1000;

    // Fixtures beyond 24h, excluding finished
    const targets = existing.filter(m => {
      if (FINISHED_STATUSES.has(m.status)) return false;
      const d = new Date(m.date).getTime();
      return d > cutoff24h;
    });

    if (targets.length === 0) {
      console.log("No eligible fixtures beyond 24h window.");
      _busy = false;
      return;
    }

    console.log(`  Updating odds for ${targets.length} fixtures (beyond 24h)...`);
    let updated = 0;
    for (const match of targets) {
      const bets = await fetchOddsForFixture(match.id);
      if (bets.length > 0) {
        match.bets = bets;
        updated++;
      }
      await sleep(350);
    }

    saveData(existing);
    console.log(`Odds updated for ${updated}/${targets.length} fixtures`);
  } catch (err) {
    console.error("\nOdds update (extended) failed:", err.message);
  }

  _busy = false;
}

// ── CLI ──
const args = process.argv.slice(2);
if (args.includes("--status")) checkStatus();
else if (args.includes("--once")) fullRefresh();
else if (args.includes("--odds24")) oddsUpdate24h();
else if (args.includes("--oddsext")) oddsUpdateExtended();
else if (require.main === module && args.length > 0) {
  console.log("Usage:");
  console.log("  node fetch-data.js --status    Check API account");
  console.log("  node fetch-data.js --once      Full refresh (fixtures + odds)");
  console.log("  node fetch-data.js --odds24    Update odds for 24h fixtures");
  console.log("  node fetch-data.js --oddsext   Update odds for extended fixtures");
}

module.exports = { fullRefresh, oddsUpdate24h, oddsUpdateExtended };
