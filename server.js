// ============================================
// BETZONE SERVER — Real-Time Architecture
// ============================================
// SSE-powered live odds & scores. No frontend polling.
//
// Data loops (server-side):
//   Live odds:       fetchLiveOdds()          every 5s    (HIGHEST PRIORITY)
//   Live scores:     fetchLiveFixtures()      every 15s
//   Pre-match odds:  fetchPreMatchOdds(id)    every 2h per fixture
//   Daily fixtures:  fetchFixturesByRange()   once daily
//   Settlement:      settleBets()             on match finish + every 60s
//
// SSE events pushed to /api/live-stream:
//   connected       – initial handshake + current live odds
//   liveOdds        – live in-play odds (every 5s)
//   liveScores      – live fixture statuses & scores (every 15s)
//   fixturesUpdate  – after daily fixture refresh
//   oddsUpdate      – after pre-match odds refresh
//   settled         – after bet settlement

const express = require("express");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const {
  fetchFixturesByRange,
  fetchLiveFixtures,
  fetchLiveOdds,
  fetchPreMatchOdds,
  saveData,
  loadExistingData,
  formatDate,
  sleep,
  isApiKeyConfigured,
} = require("./fetch-data");

const app = express();
const PORT = process.env.PORT || 8000;
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const BETS_FILE = path.join(DATA_DIR, "bets.json");

// ══════════════════════════════════════════
// IN-MEMORY STATE
// ══════════════════════════════════════════
let matches = [];              // Full match list
let currentLiveOdds = [];      // Latest live odds snapshot
let lastDailyRefresh = 0;      // Epoch ms of last fixture refresh
let lastPreMatchOdds = 0;      // Epoch ms of last pre-match odds cycle
let lastMatchUpdate = null;    // ISO string for API responses
let _liveOddsBusy = false;
let _liveFixturesBusy = false;
let _preMatchBusy = false;
let _dailyBusy = false;

// Status sets
const LIVE_SHORT = new Set(["1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE"]);
const FINISHED_SHORT = new Set(["FT", "AET", "PEN"]);
const SETTLED_STATUSES_BET = new Set(["Match Finished", "After Extra Time", "After Penalty"]);
const VOID_STATUSES_BET = new Set(["Match Postponed", "Match Cancelled", "Match Abandoned"]);
const SKIP_ODDS_SHORT = new Set(["FT", "AET", "PEN", "PST", "CANC", "ABD", "AWD", "WO"]);

// ══════════════════════════════════════════
// SSE CLIENT MANAGEMENT
// ══════════════════════════════════════════
let sseClients = [];

function broadcast(event, data) {
  if (sseClients.length === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(msg); } catch (e) { /* disconnected */ }
  }
}

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([
    { id: "ali", password: "ali123", displayName: "Ali Yilmaz", credits: 0 },
    { id: "mehmet", password: "mehmet123", displayName: "Mehmet Demir", credits: 0 },
    { id: "ayse", password: "ayse123", displayName: "Ayse Kaya", credits: 0 },
    { id: "emre", password: "emre123", displayName: "Emre Celik", credits: 0 },
    { id: "zeynep", password: "zeynep123", displayName: "Zeynep Arslan", credits: 0 },
  ], null, 2));
}

// Load existing match data into memory
matches = loadExistingData();
if (matches.length > 0) {
  lastMatchUpdate = new Date().toISOString();
  console.log(`[INIT] Loaded ${matches.length} matches from disk`);
}

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ══════════════════════════════════════════
// HELPERS: read/write users & bets
// ══════════════════════════════════════════
function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")); }
  catch (e) { return []; }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function readBets() {
  try {
    if (fs.existsSync(BETS_FILE)) return JSON.parse(fs.readFileSync(BETS_FILE, "utf-8"));
  } catch (e) {}
  return [];
}
function writeBets(bets) {
  fs.writeFileSync(BETS_FILE, JSON.stringify(bets, null, 2));
}

// ══════════════════════════════════════════
// SSE ENDPOINT
// ══════════════════════════════════════════
app.get("/api/live-stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Initial state
  res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString(), clients: sseClients.length + 1 })}\n\n`);
  if (currentLiveOdds.length > 0) {
    res.write(`event: liveOdds\ndata: ${JSON.stringify(currentLiveOdds)}\n\n`);
  }

  // Heartbeat every 25s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(`:ping\n\n`); } catch (e) {}
  }, 25000);

  const client = { id: Date.now() + Math.random(), res };
  sseClients.push(client);
  console.log(`[SSE] + Client connected (${sseClients.length} total)`);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter(c => c.id !== client.id);
    console.log(`[SSE] - Client disconnected (${sseClients.length} total)`);
  });
});

// ══════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════
app.post("/api/auth/login", (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.json({ success: false, error: "Missing fields" });

  const adminId = process.env.ADMIN_ID || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "";
  if (id.toLowerCase() === adminId.toLowerCase() && password === adminPass) {
    return res.json({ success: true, user: { id: adminId, displayName: "Admin", credits: 0, isAdmin: true } });
  }

  const users = readUsers();
  const user = users.find(u => u.id.toLowerCase() === id.toLowerCase() && u.password === password);
  if (user) {
    res.json({ success: true, user: { id: user.id, displayName: user.displayName, credits: user.credits } });
  } else {
    res.json({ success: false, error: "Invalid credentials" });
  }
});

// ══════════════════════════════════════════
// USER ROUTES
// ══════════════════════════════════════════
app.get("/api/users", (req, res) => {
  const users = readUsers();
  res.json(users.map(u => ({ id: u.id, displayName: u.displayName, credits: u.credits })));
});

app.post("/api/users", (req, res) => {
  const { id, password, displayName } = req.body;
  if (!id || !password || !displayName) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }
  const users = readUsers();
  if (users.find(u => u.id.toLowerCase() === id.toLowerCase())) {
    return res.status(409).json({ success: false, error: "User already exists" });
  }
  const newUser = { id: id.toLowerCase().trim(), password, displayName: displayName.trim(), credits: 0 };
  users.push(newUser);
  writeUsers(users);
  res.json({ success: true, user: { id: newUser.id, displayName: newUser.displayName, credits: 0 } });
});

app.delete("/api/users/:id", (req, res) => {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: "User not found" });
  users.splice(idx, 1);
  writeUsers(users);
  res.json({ success: true });
});

app.post("/api/users/:id/credits", (req, res) => {
  const { action, amount } = req.body;
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, error: "User not found" });

  const amt = parseFloat(amount) || 0;
  if (amt < 0) return res.status(400).json({ success: false, error: "Amount must be positive" });

  if (action === "add") user.credits += amt;
  else if (action === "subtract") user.credits = Math.max(0, user.credits - amt);
  else if (action === "set") user.credits = Math.max(0, amt);
  else return res.status(400).json({ success: false, error: "Invalid action (add|subtract|set)" });

  writeUsers(users);
  res.json({ success: true, credits: user.credits });
});

app.get("/api/users/:id", (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false });
  res.json({ id: user.id, displayName: user.displayName, credits: user.credits });
});

// ══════════════════════════════════════════
// BET ROUTES
// ══════════════════════════════════════════
app.post("/api/bets", (req, res) => {
  const { userId, selections, stake, totalOdds, possibleWin } = req.body;
  if (!userId || !selections || !stake || !totalOdds) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }
  const users = readUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ success: false, error: "User not found" });
  if (user.credits < stake) return res.status(400).json({ success: false, error: "Insufficient credits" });

  user.credits -= parseFloat(stake);
  writeUsers(users);

  const bet = {
    id: "BZ" + Date.now().toString(36).toUpperCase(),
    userId,
    timestamp: new Date().toISOString(),
    selections,
    stake: parseFloat(stake),
    totalOdds: parseFloat(totalOdds),
    possibleWin: parseFloat(possibleWin),
    status: "pending",
    settledAt: null,
  };
  const bets = readBets();
  bets.unshift(bet);
  writeBets(bets);
  res.json({ success: true, bet: { id: bet.id, status: bet.status }, credits: user.credits });
});

app.get("/api/bets/:userId", (req, res) => {
  const bets = readBets();
  res.json(bets.filter(b => b.userId === req.params.userId));
});

// ══════════════════════════════════════════
// MATCH DATA ENDPOINT
// ══════════════════════════════════════════
app.get("/api/matches", (req, res) => {
  res.json({
    lastUpdated: lastMatchUpdate,
    matchCount: matches.length,
    matches,
    liveOdds: currentLiveOdds,
  });
});

// ══════════════════════════════════════════
// SERVER STATUS
// ══════════════════════════════════════════
app.get("/api/status", (req, res) => {
  const liveCount = matches.filter(m => LIVE_SHORT.has(m.statusShort)).length;
  res.json({
    status: "running",
    lastUpdated: lastMatchUpdate,
    matchCount: matches.length,
    liveCount,
    sseClients: sseClients.length,
    apiKeyConfigured: isApiKeyConfigured(),
    lastDailyRefresh: lastDailyRefresh ? new Date(lastDailyRefresh).toISOString() : null,
    lastPreMatchOdds: lastPreMatchOdds ? new Date(lastPreMatchOdds).toISOString() : null,
  });
});

// ══════════════════════════════════════════
// MANUAL TRIGGERS
// ══════════════════════════════════════════
app.post("/api/fetch/daily", async (req, res) => {
  try { await dailyRefresh(); res.json({ success: true, matchCount: matches.length }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post("/api/fetch/prematch", async (req, res) => {
  try { await refreshPreMatchOdds(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post("/api/settle", (req, res) => {
  const result = settleBets();
  res.json({ success: true, ...result });
});

// ══════════════════════════════════════════
// BET SETTLEMENT
// ══════════════════════════════════════════
function evaluateSelection(sel, match) {
  const h = match.score.home;
  const a = match.score.away;
  const total = h + a;
  const pick = sel.pick;
  const betId = sel.betId;

  // Match Winner (1) / Home/Away (2)
  if (betId === 1 || betId === 2) {
    if (pick === "Home") return h > a ? "won" : "lost";
    if (pick === "Draw") return h === a ? "won" : "lost";
    if (pick === "Away") return a > h ? "won" : "lost";
  }
  // Goals Over/Under (5)
  if (betId === 5) {
    const m = pick.match(/^(Over|Under)\s+([\d.]+)$/);
    if (m) {
      const line = parseFloat(m[2]);
      return m[1] === "Over" ? (total > line ? "won" : "lost") : (total < line ? "won" : "lost");
    }
  }
  // Home Total Goals (17)
  if (betId === 17) {
    const m = pick.match(/^(Over|Under)\s+([\d.]+)$/);
    if (m) {
      const line = parseFloat(m[2]);
      return m[1] === "Over" ? (h > line ? "won" : "lost") : (h < line ? "won" : "lost");
    }
  }
  // Away Total Goals (18)
  if (betId === 18) {
    const m = pick.match(/^(Over|Under)\s+([\d.]+)$/);
    if (m) {
      const line = parseFloat(m[2]);
      return m[1] === "Over" ? (a > line ? "won" : "lost") : (a < line ? "won" : "lost");
    }
  }
  // Both Teams Score (8)
  if (betId === 8) {
    const both = h > 0 && a > 0;
    return pick === "Yes" ? (both ? "won" : "lost") : (!both ? "won" : "lost");
  }
  // Exact Score (10)
  if (betId === 10) return pick === h + ":" + a ? "won" : "lost";
  // Double Chance (12)
  if (betId === 12) {
    if (pick === "Home/Draw") return h >= a ? "won" : "lost";
    if (pick === "Home/Away") return h !== a ? "won" : "lost";
    if (pick === "Draw/Away") return a >= h ? "won" : "lost";
  }
  // Exact Goal Number (16)
  if (betId === 16) {
    const num = parseInt(pick);
    if (!isNaN(num)) return total === num ? "won" : "lost";
    if (pick.includes("+")) { const min = parseInt(pick); if (!isNaN(min)) return total >= min ? "won" : "lost"; }
  }
  // Odd/Even (21)
  if (betId === 21) return pick === "Odd" ? (total % 2 !== 0 ? "won" : "lost") : (total % 2 === 0 ? "won" : "lost");
  // Home Odd/Even (52)
  if (betId === 52) return pick === "Odd" ? (h % 2 !== 0 ? "won" : "lost") : (h % 2 === 0 ? "won" : "lost");
  // Away Odd/Even (53)
  if (betId === 53) return pick === "Odd" ? (a % 2 !== 0 ? "won" : "lost") : (a % 2 === 0 ? "won" : "lost");

  // Bet types we can't auto-settle (corners, cards, players, handicap, halftime-based)
  // For demo: treat as "won" so bets don't stay pending forever
  return "won";
}

function settleBets() {
  const bets = readBets();
  if (matches.length === 0 || bets.length === 0) return { settled: 0 };

  let settled = 0;
  const users = readUsers();

  for (const bet of bets) {
    if (bet.status !== "pending") continue;

    let allFinished = true;
    let anyLost = false;
    let anyVoid = false;

    for (const sel of bet.selections) {
      const match = matches.find(m => m.id === sel.matchId);
      if (!match || !match.score || match.score.home === null) {
        if (match && VOID_STATUSES_BET.has(match.status)) { anyVoid = true; sel.result = "void"; }
        else if (!match || !SETTLED_STATUSES_BET.has(match.status || "")) { allFinished = false; }
        continue;
      }
      if (VOID_STATUSES_BET.has(match.status)) { anyVoid = true; sel.result = "void"; continue; }
      if (!SETTLED_STATUSES_BET.has(match.status)) { allFinished = false; continue; }

      const result = evaluateSelection(sel, match);
      sel.result = result;
      if (result === "lost") anyLost = true;
    }

    if (anyVoid) {
      bet.status = "void";
      bet.settledAt = new Date().toISOString();
      const user = users.find(u => u.id === bet.userId);
      if (user) user.credits += bet.stake;
      settled++;
    } else if (anyLost) {
      bet.status = "lost";
      bet.settledAt = new Date().toISOString();
      settled++;
    } else if (allFinished) {
      bet.status = "won";
      bet.settledAt = new Date().toISOString();
      const user = users.find(u => u.id === bet.userId);
      if (user) user.credits += bet.possibleWin;
      settled++;
    }
  }

  if (settled > 0) {
    writeUsers(users);
    writeBets(bets);
    console.log(`[SETTLE] Settled ${settled} bet(s)`);
  }
  return { settled };
}

// ══════════════════════════════════════════
// LIVE DATA ENGINE
// ══════════════════════════════════════════

// ── Live Odds — every 5 seconds (HIGHEST PRIORITY) ──
async function tickLiveOdds() {
  if (_liveOddsBusy) return;
  _liveOddsBusy = true;
  try {
    const odds = await fetchLiveOdds();
    currentLiveOdds = odds;
    if (odds.length > 0) {
      broadcast("liveOdds", odds);
    }
  } catch (e) {
    console.error("[LIVE-ODDS] Error:", e.message);
  } finally {
    _liveOddsBusy = false;
  }
}

// ── Live Fixtures — every 15 seconds ──
async function tickLiveFixtures() {
  if (_liveFixturesBusy) return;
  _liveFixturesBusy = true;
  try {
    const liveData = await fetchLiveFixtures();
    const updates = [];
    const newlyFinished = [];

    for (const live of liveData) {
      const match = matches.find(m => m.id === live.id);
      if (!match) continue;

      const wasNotFinished = !FINISHED_SHORT.has(match.statusShort);
      const isNowFinished = FINISHED_SHORT.has(live.statusShort);

      // Update in-memory match data
      match.status = live.status;
      match.statusShort = live.statusShort;
      match.elapsed = live.elapsed;
      if (live.score) match.score = live.score;

      updates.push({
        id: live.id,
        status: live.status,
        statusShort: live.statusShort,
        elapsed: live.elapsed,
        score: live.score,
      });

      if (wasNotFinished && isNowFinished) {
        newlyFinished.push(match);
      }
    }

    // Also check: matches we thought were live but aren't in the response anymore
    // They may have finished between checks
    for (const match of matches) {
      if (LIVE_SHORT.has(match.statusShort) && !liveData.find(l => l.id === match.id)) {
        // Match was live but not in live response — might have finished
        // We'll catch this in the periodic settlement check
      }
    }

    if (updates.length > 0) {
      broadcast("liveScores", updates);
      saveData(matches);
      lastMatchUpdate = new Date().toISOString();
    }

    // Immediate settlement on finish detection
    if (newlyFinished.length > 0) {
      console.log(`[ENGINE] ${newlyFinished.length} match(es) just finished: ${newlyFinished.map(m => m.id).join(", ")}`);
      const result = settleBets();
      if (result.settled > 0) {
        broadcast("settled", { settled: result.settled, time: new Date().toISOString() });
      }
    }
  } catch (e) {
    console.error("[LIVE-FIXTURES] Error:", e.message);
  } finally {
    _liveFixturesBusy = false;
  }
}

// ── Daily Fixture Refresh ──
async function dailyRefresh() {
  if (_dailyBusy) return;
  _dailyBusy = true;
  try {
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(now); dayAfter.setDate(dayAfter.getDate() + 2);

    console.log(`[DAILY] Fetching fixtures ${formatDate(yesterday)} to ${formatDate(dayAfter)}...`);
    const newFixtures = await fetchFixturesByRange(formatDate(yesterday), formatDate(dayAfter));

    // Merge: preserve live scores/status and existing odds from memory
    for (const nf of newFixtures) {
      const existing = matches.find(m => m.id === nf.id);
      if (existing) {
        // Keep live data if match is currently in play
        if (LIVE_SHORT.has(existing.statusShort)) {
          nf.status = existing.status;
          nf.statusShort = existing.statusShort;
          nf.elapsed = existing.elapsed;
          nf.score = existing.score;
        }
        // Keep existing pre-match odds if new fixture has none
        if ((!nf.bets || nf.bets.length === 0) && existing.bets && existing.bets.length > 0) {
          nf.bets = existing.bets;
        }
      }
    }

    matches = newFixtures;
    saveData(matches);
    lastMatchUpdate = new Date().toISOString();
    lastDailyRefresh = Date.now();

    console.log(`[DAILY] ${matches.length} fixtures loaded`);
    broadcast("fixturesUpdate", { count: matches.length, time: lastMatchUpdate });
  } catch (e) {
    console.error("[DAILY] Error:", e.message);
  } finally {
    _dailyBusy = false;
  }
}

// ── Pre-Match Odds Refresh (every 2 hours) ──
async function refreshPreMatchOdds() {
  if (_preMatchBusy) return;
  _preMatchBusy = true;
  try {
    const eligible = matches.filter(m =>
      !LIVE_SHORT.has(m.statusShort) &&
      !SKIP_ODDS_SHORT.has(m.statusShort)
    );

    console.log(`[PRE-MATCH] Updating odds for ${eligible.length} fixtures...`);
    let updated = 0;

    for (const match of eligible) {
      try {
        const bets = await fetchPreMatchOdds(match.id);
        if (bets.length > 0) {
          match.bets = bets;
          updated++;
        }
        // Small delay between calls to stay well within rate limits
        await sleep(350);
      } catch (e) {
        console.error(`[PRE-MATCH] Fixture ${match.id}: ${e.message}`);
      }
    }

    if (updated > 0) {
      saveData(matches);
      lastMatchUpdate = new Date().toISOString();
      broadcast("oddsUpdate", { updated, time: lastMatchUpdate });
    }

    lastPreMatchOdds = Date.now();
    console.log(`[PRE-MATCH] Updated ${updated}/${eligible.length} fixtures`);
  } catch (e) {
    console.error("[PRE-MATCH] Error:", e.message);
  } finally {
    _preMatchBusy = false;
  }
}

// ══════════════════════════════════════════
// ENGINE START
// ══════════════════════════════════════════
function startEngine() {
  if (!isApiKeyConfigured()) {
    console.log("[ENGINE] API key not configured — mock data only");
    return;
  }

  console.log("[ENGINE] Starting real-time data engine...");
  console.log("  Live odds:       every 5s");
  console.log("  Live fixtures:   every 15s");
  console.log("  Pre-match odds:  every 2h");
  console.log("  Daily fixtures:  every 24h");
  console.log("  Settlement:      on finish + every 60s\n");

  // ── HIGHEST PRIORITY: Live odds every 5 seconds ──
  setInterval(tickLiveOdds, 5000);

  // ── Live fixture statuses every 15 seconds ──
  setInterval(tickLiveFixtures, 15000);

  // ── Settlement safety net: every 60 seconds ──
  setInterval(() => {
    const result = settleBets();
    if (result.settled > 0) {
      broadcast("settled", { settled: result.settled, time: new Date().toISOString() });
    }
  }, 60000);

  // ── Pre-match odds: check every 5 minutes, refresh if >2h stale ──
  setInterval(() => {
    if (Date.now() - lastPreMatchOdds > 2 * 60 * 60 * 1000) {
      refreshPreMatchOdds();
    }
  }, 5 * 60 * 1000);

  // ── Daily fixtures: check every hour, refresh if >23h stale ──
  setInterval(() => {
    if (Date.now() - lastDailyRefresh > 23 * 60 * 60 * 1000) {
      dailyRefresh();
    }
  }, 60 * 60 * 1000);

  // ── Initial load ──
  dailyRefresh().then(() => {
    refreshPreMatchOdds().then(() => {
      settleBets();
      console.log("[ENGINE] Initial load complete\n");
    });
  });
}

// ══════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`BetZone server running at http://localhost:${PORT}`);
  console.log("=".repeat(50));

  if (!isApiKeyConfigured()) {
    console.log("API key not configured. Edit .env and set API_FOOTBALL_KEY");
    console.log("The site will work with mock data until then.\n");
  } else {
    console.log("API key configured. Starting real-time engine...\n");
  }

  startEngine();
});
