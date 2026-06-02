// ============================================
// API-FOOTBALL DATA FETCHER (v3) — Clean API module
// ============================================
// Pure API calling functions. No loops — server.js orchestrates.
//
// Endpoints used:
//   GET /fixtures?from=&to=       Fixture list (daily refresh)
//   GET /fixtures?live=all        Live scores & status (every 5-15s)
//   GET /odds?fixture=X           Pre-match Bet365 odds (every 2h)
//   GET /odds/live                Live in-play odds (every 5s)
//
// CLI:
//   node fetch-data.js --status
//   node fetch-data.js --fixtures
//   node fetch-data.js --live-odds

const https = require("https");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const API_KEY = process.env.API_FOOTBALL_KEY;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "matches.json");
const BET365_ID = 8;

// Pre-match bet IDs whitelist (Goal Line 50, 55 removed)
const ALLOWED_BET_IDS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 25, 26, 29, 31, 34, 35, 36, 37, 38, 39, 40,
  42, 43, 44, 45, 46, 47, 48, 49, 51, 52, 53, 63, 72, 77, 85, 86, 87,
]);

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
        if (remaining) console.log(`  Remaining: ${remaining}/${limit}`);
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

// ── Helpers ──
function formatDate(d) { return d.toISOString().split("T")[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isApiKeyConfigured() { return !!API_KEY && API_KEY.length > 5; }

// ── Fetch fixtures by date range (per-date calls — from/to requires league+season) ──
async function fetchFixturesByRange(from, to) {
  // Build list of dates in range
  const dates = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(formatDate(new Date(d)));
  }

  console.log(`\n[FIXTURES] Dates: ${dates.join(", ")}`);
  const allResults = [];
  const seenIds = new Set();

  for (const date of dates) {
    const data = await apiRequest("fixtures", { date });
    const fixtures = data.response || [];

    for (const item of fixtures) {
      if (seenIds.has(item.fixture.id)) continue;
      seenIds.add(item.fixture.id);
      allResults.push({
        id: item.fixture.id,
        date: item.fixture.date,
        status: item.fixture.status.long,
        statusShort: item.fixture.status.short,
        elapsed: item.fixture.status.elapsed,
        league: {
          id: item.league.id,
          name: item.league.name,
          country: item.league.country,
          logo: item.league.logo,
          flag: item.league.flag,
        },
        home: { id: item.teams.home.id, name: item.teams.home.name, logo: item.teams.home.logo },
        away: { id: item.teams.away.id, name: item.teams.away.name, logo: item.teams.away.logo },
        score: item.goals.home !== null ? { home: item.goals.home, away: item.goals.away } : null,
        htScore: item.score?.halftime?.home !== null ? { home: item.score.halftime.home, away: item.score.halftime.away } : null,
        bets: [],
      });
    }

    if (dates.length > 1) await sleep(300); // small delay between date calls
  }

  console.log(`  Found ${allResults.length} unique fixtures across ${dates.length} days`);
  return allResults;
}

// ── Fetch all live fixtures (1 API call) ──
async function fetchLiveFixtures() {
  const data = await apiRequest("fixtures", { live: "all" });
  return (data.response || []).map(item => ({
    id: item.fixture.id,
    status: item.fixture.status.long,
    statusShort: item.fixture.status.short,
    elapsed: item.fixture.status.elapsed,
    score: item.goals.home !== null ? { home: item.goals.home, away: item.goals.away } : null,
    htScore: item.score?.halftime?.home !== null ? { home: item.score.halftime.home, away: item.score.halftime.away } : null,
  }));
}

// ── Fetch all live odds (1 API call — returns every in-play fixture's odds) ──
// Response includes per-fixture: status (stopped/blocked/finished), odds with suspended flags
async function fetchLiveOdds() {
  const data = await apiRequest("odds/live");
  const raw = data.response || [];

  return raw.map(item => ({
    fixtureId: item.fixture.id,
    fixtureStatus: {
      stopped: item.status?.stopped || false,
      blocked: item.status?.blocked || false,
      finished: item.status?.finished || false,
    },
    update: item.update,
    odds: (item.odds || []).filter(bet => ALLOWED_BET_IDS.has(bet.id)).map(bet => ({
      id: bet.id,
      name: bet.name,
      values: (bet.values || []).map(v => {
        // Combine value + handicap into a single value so each option is unique
        // e.g. "Over" + handicap "2.5" → "Over 2.5", "Home" + handicap "3" → "Home 3"
        const hasHC = v.handicap != null && v.handicap !== "" && String(v.handicap) !== "null";
        const combinedValue = hasHC ? v.value + " " + v.handicap : v.value;
        return {
          value: combinedValue,
          odd: v.odd,
          handicap: v.handicap,   // keep original for sorting
          main: v.main,
          suspended: v.suspended || false,
        };
      }),
    })),
  }));
}

// ── Fetch pre-match Bet365 odds for a single fixture ──
async function fetchPreMatchOdds(fixtureId) {
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

// ── File I/O ──
function saveData(matches) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = { lastUpdated: new Date().toISOString(), matchCount: matches.length, matches };
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
}

function loadExistingData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")).matches || [];
    }
  } catch (e) {}
  return [];
}

// ── Exports ──
module.exports = {
  apiRequest,
  fetchFixturesByRange,
  fetchLiveFixtures,
  fetchLiveOdds,
  fetchPreMatchOdds,
  saveData,
  loadExistingData,
  formatDate,
  sleep,
  isApiKeyConfigured,
  ALLOWED_BET_IDS,
  BET365_ID,
};

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--status")) {
    apiRequest("status").then(d => console.log(JSON.stringify(d, null, 2))).catch(console.error);
  } else if (args.includes("--fixtures")) {
    const now = new Date();
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const d2 = new Date(now); d2.setDate(d2.getDate() + 2);
    fetchFixturesByRange(formatDate(y), formatDate(d2))
      .then(f => { console.log(`Fetched ${f.length} fixtures`); saveData(f); })
      .catch(console.error);
  } else if (args.includes("--live-odds")) {
    fetchLiveOdds().then(d => console.log(JSON.stringify(d, null, 2))).catch(console.error);
  } else if (args.includes("--live-fixtures")) {
    fetchLiveFixtures().then(d => console.log(JSON.stringify(d, null, 2))).catch(console.error);
  } else {
    console.log("Usage:");
    console.log("  node fetch-data.js --status         Check API account");
    console.log("  node fetch-data.js --fixtures        Fetch fixtures (yesterday to day-after-tomorrow)");
    console.log("  node fetch-data.js --live-odds       Fetch live odds");
    console.log("  node fetch-data.js --live-fixtures    Fetch live fixture statuses");
  }
}
