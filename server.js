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
const compression = require("compression");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const {
  fetchFixturesByRange,
  fetchLiveFixtures,
  fetchLiveOdds,
  fetchPreMatchOdds,
  fetchFixtureStatistics,
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
const STALE_THRESHOLD_MS = 90000;  // 90 seconds — disable odds if unchanged
const _oddsFingerprints = {};  // { fixtureId: { hash: string, lastChanged: epochMs } }
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
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── /logout route: serve app.html which auto-detects and logs out ──
app.get("/logout", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

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
  const { userId, selections, stake, totalOdds, possibleWin, mode } = req.body;
  if (!userId || !selections || !stake || (totalOdds == null && !mode)) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }
  const users = readUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ success: false, error: "User not found" });

  // System: total cost = stake × selections count. Combined: cost = stake.
  const betMode = mode || "combined";
  const totalCost = betMode === "system" ? parseFloat(stake) * selections.length : parseFloat(stake);
  if (user.credits < totalCost) return res.status(400).json({ success: false, error: "Insufficient credits" });

  user.credits -= totalCost;
  writeUsers(users);

  const bet = {
    id: "BZ" + Date.now().toString(36).toUpperCase(),
    userId,
    timestamp: new Date().toISOString(),
    mode: betMode,
    selections,
    stake: parseFloat(stake),       // per-bet stake for system, total stake for combined
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
  // Only send matches the client will actually display (have odds or are live)
  const relevant = matches.filter(m =>
    (m.bets && m.bets.length > 0) || LIVE_SHORT.has(m.statusShort)
  );
  res.json({
    lastUpdated: lastMatchUpdate,
    matchCount: matches.length,
    matches: relevant,
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
app.post("/api/settle", async (req, res) => {
  const result = await settleBets();
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

  // Halftime score (may be null for older data)
  const ht = match.htScore || null;
  const htH = ht ? ht.home : null;
  const htA = ht ? ht.away : null;
  const htTotal = ht ? htH + htA : null;
  // Second half derived from FT - HT
  const h2H = ht ? h - htH : null;
  const h2A = ht ? a - htA : null;
  const h2Total = ht ? (h2H + h2A) : null;

  // ── Helper: evaluate Over/Under pick ──
  function evalOU(goalCount, pickStr) {
    const m = pickStr.match(/^(Over|Under)\s+([\d.]+)$/);
    if (!m) return null;
    const line = parseFloat(m[2]);
    return m[1] === "Over" ? (goalCount > line ? "won" : "lost") : (goalCount < line ? "won" : "lost");
  }

  // ── Helper: evaluate Home/Draw/Away result ──
  function evalResult(homeGoals, awayGoals, pickStr) {
    if (pickStr === "Home") return homeGoals > awayGoals ? "won" : "lost";
    if (pickStr === "Draw") return homeGoals === awayGoals ? "won" : "lost";
    if (pickStr === "Away") return awayGoals > homeGoals ? "won" : "lost";
    return null;
  }

  // ── Helper: evaluate Asian Handicap pick (e.g., "Home -1.5") ──
  function evalAsianHandicap(homeGoals, awayGoals, pickStr) {
    const m = pickStr.match(/^(Home|Away)\s+([+-]?\d+\.?\d*)$/);
    if (!m) return null;
    const side = m[1];
    const line = parseFloat(m[2]);
    // Apply handicap to the selected side
    const adjusted = side === "Home" ? (homeGoals + line) - awayGoals : (awayGoals + line) - homeGoals;
    if (adjusted > 0) return "won";
    if (adjusted < 0) return "lost";
    return "void"; // push — exact 0 = stake refund
  }

  // ═══ FULL-TIME BETS (only need final score) ═══

  // Match Winner (1) / Home/Away (2)
  if (betId === 1 || betId === 2) return evalResult(h, a, pick);

  // Goals Over/Under (5) / Goal Line (50)
  if (betId === 5 || betId === 50) return evalOU(total, pick);

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

  // Home Total Goals O/U (17)
  if (betId === 17) return evalOU(h, pick);

  // Away Total Goals O/U (18)
  if (betId === 18) return evalOU(a, pick);

  // Odd/Even (21)
  if (betId === 21) return pick === "Odd" ? (total % 2 !== 0 ? "won" : "lost") : (total % 2 === 0 ? "won" : "lost");

  // Home Odd/Even (52)
  if (betId === 52) return pick === "Odd" ? (h % 2 !== 0 ? "won" : "lost") : (h % 2 === 0 ? "won" : "lost");

  // Away Odd/Even (53)
  if (betId === 53) return pick === "Odd" ? (a % 2 !== 0 ? "won" : "lost") : (a % 2 === 0 ? "won" : "lost");

  // Asian Handicap full-time (4)
  if (betId === 4) return evalAsianHandicap(h, a, pick);

  // Handicap Result 3-way (51) — e.g., "Home +1", "Draw -3", "Away -2"
  // Negative line → handicap on away (favorite). Positive line → handicap on home (underdog).
  if (betId === 51) {
    const m = pick.match(/^(Home|Draw|Away)\s+([+-]?\d+\.?\d*)$/);
    if (m) {
      const line = parseFloat(m[2]);
      if (line < 0) return evalResult(h, a + line, m[1]); // away gets handicap
      else return evalResult(h + line, a, m[1]);           // home gets handicap
    }
  }

  // ═══ FIRST-HALF BETS (need htScore) ═══

  if (ht === null) return null; // can't evaluate without HT data — stays pending

  // First Half Winner (13)
  if (betId === 13) return evalResult(htH, htA, pick);

  // Goals O/U First Half (6) / Goal Line 1st Half (55)
  if (betId === 6 || betId === 55) return evalOU(htTotal, pick);

  // HT/FT (7) — e.g., "Home/Away" means home winning at HT, away winning at FT
  if (betId === 7) {
    const parts = pick.split("/");
    if (parts.length === 2) {
      const htResult = htH > htA ? "Home" : htH < htA ? "Away" : "Draw";
      const ftResult = h > a ? "Home" : h < a ? "Away" : "Draw";
      return (parts[0] === htResult && parts[1] === ftResult) ? "won" : "lost";
    }
  }

  // Asian Handicap First Half (19)
  if (betId === 19) return evalAsianHandicap(htH, htA, pick);

  // Double Chance First Half (20)
  if (betId === 20) {
    if (pick === "Home/Draw") return htH >= htA ? "won" : "lost";
    if (pick === "Home/Away") return htH !== htA ? "won" : "lost";
    if (pick === "Draw/Away") return htA >= htH ? "won" : "lost";
  }

  // Odd/Even First Half (22)
  if (betId === 22) return pick === "Odd" ? (htTotal % 2 !== 0 ? "won" : "lost") : (htTotal % 2 === 0 ? "won" : "lost");

  // BTS First Half (25)
  if (betId === 25) {
    const both = htH > 0 && htA > 0;
    return pick === "Yes" ? (both ? "won" : "lost") : (!both ? "won" : "lost");
  }

  // BTS Second Half (26)
  if (betId === 26) {
    const both = h2H > 0 && h2A > 0;
    return pick === "Yes" ? (both ? "won" : "lost") : (!both ? "won" : "lost");
  }

  // Correct Score First Half (31)
  if (betId === 31) return pick === htH + ":" + htA ? "won" : "lost";

  // Odd/Even Second Half (63)
  if (betId === 63) return pick === "Odd" ? (h2Total % 2 !== 0 ? "won" : "lost") : (h2Total % 2 === 0 ? "won" : "lost");

  // Goals O/U Second Half (72)
  if (betId === 72) return evalOU(h2Total, pick);

  // Win Both Halves (3) — "Home" means home wins both halves separately
  if (betId === 3) {
    if (pick === "Home") return (htH > htA && h2H > h2A) ? "won" : "lost";
    if (pick === "Away") return (htA > htH && h2A > h2H) ? "won" : "lost";
    if (pick === "Yes") return ((htH > htA && h2H > h2A) || (htA > htH && h2A > h2H)) ? "won" : "lost";
    if (pick === "No") return (!((htH > htA && h2H > h2A) || (htA > htH && h2A > h2H))) ? "won" : "lost";
  }

  // ═══ NAME-BASED FALLBACK (live API uses different bet IDs) ═══
  // Live bets store the API bet name in sel.marketLabel — use it to evaluate
  const name = (sel.marketLabel || "").toLowerCase();

  // ── Full-time result bets ──
  if (/\b(1x2|match winner)\b/.test(name) && !/half/.test(name)) return evalResult(h, a, pick);
  if (/\bdraw no bet\b/.test(name) && !/half/.test(name)) {
    if (pick === "Home") return h > a ? "won" : h === a ? "void" : "lost";
    if (pick === "Away") return a > h ? "won" : h === a ? "void" : "lost";
  }
  if (/\bdouble chance\b/.test(name) && !/half/.test(name)) {
    if (pick === "Home or Draw") return h >= a ? "won" : "lost";
    if (pick === "Home or Away") return h !== a ? "won" : "lost";
    if (pick === "Away or Draw" || pick === "Draw or Away") return a >= h ? "won" : "lost";
  }

  // ── Goals Over/Under ──
  if (/\b(match goals|over.?under line)\b/.test(name)) return evalOU(total, pick);
  if (/\bhome.*(goals?|total)\b/.test(name) || /\b(goals?|total).*home\b/.test(name)) return evalOU(h, pick);
  if (/\baway.*(goals?|total)\b/.test(name) || /\b(goals?|total).*away\b/.test(name)) return evalOU(a, pick);

  // ── Both Teams Score ──
  if (/\bboth teams?.*(score|goal)\b/.test(name) && !/half/.test(name)) {
    const both = h > 0 && a > 0;
    return pick === "Yes" ? (both ? "won" : "lost") : (!both ? "won" : "lost");
  }

  // ── Odd/Even ──
  if (/\bodd.?even\b/.test(name) && !/half/.test(name)) {
    return pick === "Odd" ? (total % 2 !== 0 ? "won" : "lost") : (total % 2 === 0 ? "won" : "lost");
  }

  // ── Asian Handicap ──
  if (/\basian handicap\b/.test(name) && !/half/.test(name)) return evalAsianHandicap(h, a, pick);

  // ── 3-Way Handicap ──
  // Negative line → handicap on away (favorite). Positive line → handicap on home (underdog).
  if (/\b3.?way handicap\b/.test(name) && !/half/.test(name)) {
    const m3 = pick.match(/^(Home|Draw|Away)\s+([+-]?\d+\.?\d*)$/);
    if (m3) {
      const line = parseFloat(m3[2]);
      if (line < 0) return evalResult(h, a + line, m3[1]); // away gets handicap
      else return evalResult(h + line, a, m3[1]);           // home gets handicap
    }
  }

  // ── Exact Goals / How Many Goals ──
  if (/\bhow many goals\b/.test(name) || /\bexact.*(goals?|number)\b/.test(name)) {
    const num = parseInt(pick);
    if (!isNaN(num)) return total === num ? "won" : "lost";
    if (pick === "No goal" || pick === "No Goal") return total === 0 ? "won" : "lost";
    if (pick.includes("+") || pick.includes("or more")) {
      const min = parseInt(pick); if (!isNaN(min)) return total >= min ? "won" : "lost";
    }
  }

  // ── Second half bets (need HT score) ──
  if (ht === null && /\b(2nd half|second half)\b/.test(name)) return null; // wait for HT data

  if (/\b(to win|winner).*(2nd|second) half\b/.test(name) || /\b(2nd|second) half.*(winner|result)\b/.test(name)) {
    if (h2H === null) return null;
    return evalResult(h2H, h2A, pick);
  }
  if (/\b(over.?under|goals?).*(2nd|second) half\b/.test(name) || /\b(2nd|second) half.*(over.?under|goals?)\b/.test(name)) {
    if (h2Total === null) return null;
    return evalOU(h2Total, pick);
  }
  if (/\bboth teams?.*(score|goal).*(2nd|second) half\b/.test(name)) {
    if (h2H === null) return null;
    const both = h2H > 0 && h2A > 0;
    return pick === "Yes" ? (both ? "won" : "lost") : (!both ? "won" : "lost");
  }

  // ── First half bets ──
  if (ht === null && /\b(1st half|first half)\b/.test(name)) return null; // wait for HT data

  if (/\b(to win|winner).*(1st|first) half\b/.test(name) || /\b(1st|first) half.*(winner|result)\b/.test(name)) {
    return evalResult(htH, htA, pick);
  }
  if (/\b(over.?under|goals?).*(1st|first) half\b/.test(name) || /\b(1st|first) half.*(over.?under|goals?)\b/.test(name)) {
    return evalOU(htTotal, pick);
  }

  // ═══ STATISTICS-BASED BETS (corners, cards, shots) ═══
  const st = match.stats;
  if (!st || !st.home || !st.away) return "void"; // no stats available — void

  const totalCorners = st.totalCorners;
  const homeCorners = st.home.corners;
  const awayCorners = st.away.corners;
  const totalCards = st.totalCards;
  const homeCards = st.home.totalCards;
  const awayCards = st.away.totalCards;
  const totalShots = st.totalShotsOnGoal;
  const homeShots = st.home.shotsOnGoal;
  const awayShots = st.away.shotsOnGoal;

  // ── Corner bets ──
  if (/\b(total|match).*corner/i.test(name)) return evalOU(totalCorners, pick);
  if (/\bhome.*corner/i.test(name)) return evalOU(homeCorners, pick);
  if (/\baway.*corner/i.test(name)) return evalOU(awayCorners, pick);
  if (/\bcorner.*over.?under/i.test(name) || /\bcorner.*line/i.test(name)) return evalOU(totalCorners, pick);

  // Race to N corners — pick is "Home", "Away", or "Neither"/"No Winner"
  if (/\brace to.*corner/i.test(name)) {
    const raceMatch = name.match(/race to (?:the )?(\d+)/i);
    if (raceMatch) {
      const target = parseInt(raceMatch[1]);
      const homeReached = homeCorners >= target;
      const awayReached = awayCorners >= target;
      if (pick === "Home" || pick === "1") return homeReached ? "won" : "lost";
      if (pick === "Away" || pick === "2") return awayReached ? "won" : "lost";
      if (/neither|no winner|no goal/i.test(pick)) return (!homeReached && !awayReached) ? "won" : "lost";
    }
  }

  // "Which team will score the Nth corner?" / "Last Corner" — can't determine Nth corner from totals alone
  // We only know final totals, so void these (would need event-by-event data)
  if (/\bwhich team.*corner/i.test(name) || /\blast corner/i.test(name)) return "void";

  // Corner match result (which team got more corners)
  if (/\bcorner.*(match|result|winner)/i.test(name) || /\b(match|result).*corner/i.test(name)) {
    return evalResult(homeCorners, awayCorners, pick);
  }

  // ── Card bets ──
  if (/\b(total|match).*card/i.test(name)) return evalOU(totalCards, pick);
  if (/\bhome.*card/i.test(name)) return evalOU(homeCards, pick);
  if (/\baway.*card/i.test(name)) return evalOU(awayCards, pick);
  if (/\bcard.*over.?under/i.test(name) || /\bcard.*line/i.test(name)) return evalOU(totalCards, pick);

  // ── Shot on goal bets ──
  if (/\b(total|match).*shot/i.test(name)) return evalOU(totalShots, pick);
  if (/\bhome.*shot/i.test(name)) return evalOU(homeShots, pick);
  if (/\baway.*shot/i.test(name)) return evalOU(awayShots, pick);
  if (/\bshot.*on.*goal/i.test(name)) return evalOU(totalShots, pick);

  // ═══ TRULY UNEVALUABLE (player-specific, exotic props) ═══
  return "void";
}

async function settleBets() {
  const bets = readBets();
  if (matches.length === 0 || bets.length === 0) return { settled: 0 };

  // Fetch missing stats for finished matches that have pending bets
  const pendingMatchIds = new Set();
  for (const bet of bets) {
    if (bet.status !== "pending") continue;
    for (const sel of bet.selections) pendingMatchIds.add(sel.matchId);
  }
  for (const mid of pendingMatchIds) {
    const match = matches.find(m => m.id === mid);
    if (match && SETTLED_STATUSES_BET.has(match.status) && !match.stats) {
      try {
        const stats = await fetchFixtureStatistics(mid);
        if (stats && stats.home && stats.away) {
          match.stats = stats;
          console.log(`[SETTLE] Fetched missing stats for ${mid}`);
        }
      } catch (e) { console.error(`[SETTLE] Stats fetch failed for ${mid}: ${e.message}`); }
    }
  }

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
      if (result === null) { allFinished = false; continue; }
      sel.result = result;
      if (result === "void") anyVoid = true;
      else if (result === "lost") anyLost = true;
    }

    if (!allFinished) continue; // wait for all matches to finish

    if (bet.mode === "system") {
      // ── SYSTEM: each selection is independent ──
      // Payout = sum of (stake × odd) for each won selection. Void = refund that stake.
      let totalPayout = 0;
      let wonCount = 0, lostCount = 0, voidCount = 0;
      for (const sel of bet.selections) {
        if (sel.result === "won") { totalPayout += bet.stake * sel.odd; wonCount++; }
        else if (sel.result === "void") { totalPayout += bet.stake; voidCount++; } // refund
        else { lostCount++; }
      }
      const totalPR = Math.round(totalPayout * 100) / 100;
      if (wonCount === 0 && voidCount === 0) {
        bet.status = "lost";
      } else if (wonCount === 0 && voidCount > 0 && lostCount === 0) {
        bet.status = "void";
      } else {
        bet.status = wonCount > 0 ? "won" : "void";
      }
      bet.possibleWin = totalPR;
      bet.settledAt = new Date().toISOString();
      const user = users.find(u => u.id === bet.userId);
      if (user) user.credits += totalPR;
      settled++;
    } else {
      // ── COMBINED: all selections must win ──
      if (anyLost) {
        bet.status = "lost";
        bet.settledAt = new Date().toISOString();
        settled++;
      } else if (anyVoid) {
        const allVoid = bet.selections.every(s => s.result === "void");
        if (allVoid) {
          bet.status = "void";
          bet.settledAt = new Date().toISOString();
          const user = users.find(u => u.id === bet.userId);
          if (user) user.credits += bet.stake;
        } else {
          // Partial void: multiply only won selections' odds, void = 1.00
          const adjustedOdds = bet.selections.reduce((acc, s) => {
            return acc * (s.result === "void" ? 1.0 : s.odd);
          }, 1.0);
          const payout = Math.round(bet.stake * adjustedOdds * 100) / 100;
          bet.status = "won";
          bet.totalOdds = Math.round(adjustedOdds * 100) / 100;
          bet.possibleWin = payout;
          bet.settledAt = new Date().toISOString();
          const user = users.find(u => u.id === bet.userId);
          if (user) user.credits += payout;
        }
        settled++;
      } else {
        bet.status = "won";
        bet.settledAt = new Date().toISOString();
        const user = users.find(u => u.id === bet.userId);
        if (user) user.credits += bet.possibleWin;
        settled++;
      }
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
// Build a quick hash of all odds values for a fixture to detect changes
function oddsFingerprint(fixtureOdds) {
  let s = "";
  for (const bet of fixtureOdds) {
    for (const v of bet.values) {
      s += v.value + ":" + v.odd + ":" + (v.suspended ? "S" : "A") + "|";
    }
  }
  return s;
}

async function tickLiveOdds() {
  if (_liveOddsBusy) return;
  _liveOddsBusy = true;
  try {
    const odds = await fetchLiveOdds();
    const now = Date.now();

    // Check each fixture for staleness
    for (const item of odds) {
      const fid = item.fixtureId;
      const hash = oddsFingerprint(item.odds);
      const prev = _oddsFingerprints[fid];

      if (!prev) {
        // First time seeing this fixture
        _oddsFingerprints[fid] = { hash, lastChanged: now };
      } else if (prev.hash !== hash) {
        // Odds changed — update timestamp
        _oddsFingerprints[fid] = { hash, lastChanged: now };
      }
      // else: same hash, keep old lastChanged

      // If unchanged for > threshold, force-suspend all values
      const age = now - (_oddsFingerprints[fid]?.lastChanged || now);
      if (age > STALE_THRESHOLD_MS) {
        for (const bet of item.odds) {
          for (const v of bet.values) {
            v.suspended = true;
          }
        }
      }
    }

    // Clean up fingerprints for fixtures no longer in live odds
    for (const fid of Object.keys(_oddsFingerprints)) {
      if (!odds.find(o => String(o.fixtureId) === fid)) {
        delete _oddsFingerprints[fid];
      }
    }

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
      if (live.htScore) match.htScore = live.htScore;

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

    // Matches we thought were live but aren't in the response anymore → mark as finished
    for (const match of matches) {
      if (LIVE_SHORT.has(match.statusShort) && !liveData.find(l => l.id === match.id)) {
        console.log(`[ENGINE] Match ${match.id} disappeared from live feed — marking as FT`);
        match.status = "Match Finished";
        match.statusShort = "FT";
        updates.push({
          id: match.id,
          status: match.status,
          statusShort: match.statusShort,
          elapsed: 90,
          score: match.score,
        });
        newlyFinished.push(match);
      }
    }

    if (updates.length > 0) {
      broadcast("liveScores", updates);
      saveData(matches);
      lastMatchUpdate = new Date().toISOString();
    }

    // Fetch statistics for newly finished matches, then settle
    if (newlyFinished.length > 0) {
      console.log(`[ENGINE] ${newlyFinished.length} match(es) just finished: ${newlyFinished.map(m => m.id).join(", ")}`);
      for (const match of newlyFinished) {
        try {
          const stats = await fetchFixtureStatistics(match.id);
          if (stats && stats.home && stats.away) {
            match.stats = stats;
            console.log(`[STATS] ${match.id}: corners ${stats.home.corners}-${stats.away.corners}, cards ${stats.home.totalCards}-${stats.away.totalCards}, shots ${stats.home.shotsOnGoal}-${stats.away.shotsOnGoal}`);
          }
        } catch (e) {
          console.error(`[STATS] Failed for ${match.id}: ${e.message}`);
        }
      }
      saveData(matches);
      const result = await settleBets();
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
          nf.htScore = existing.htScore;
        }
        // Preserve halftime score from memory if available
        if (existing.htScore && !nf.htScore) nf.htScore = existing.htScore;
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
  setInterval(async () => {
    const result = await settleBets();
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
    refreshPreMatchOdds().then(async () => {
      await settleBets();
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
