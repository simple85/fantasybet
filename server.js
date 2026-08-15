// ============================================
// FANTASYBET SERVER — Real-Time Architecture
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
require("dotenv").config();

const {
  fetchFixturesByRange,
  fetchLiveFixtures,
  fetchLiveOdds,
  fetchPreMatchOdds,
  fetchFixtureStatistics,
  fetchFixtureEvents,
  formatDate,
  sleep,
  isApiKeyConfigured,
} = require("./fetch-data");
const db = require("./db");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 8000;

// ══════════════════════════════════════════
// IN-MEMORY STATE
// ══════════════════════════════════════════
let matches = [];              // Full match list
let currentLiveOdds = [];      // Latest live odds snapshot
let lastDailyRefresh = 0;      // Epoch ms of last fixture refresh
let lastPreMatchOdds = 0;      // Epoch ms of last pre-match odds cycle
let lastMatchUpdate = null;    // ISO string for API responses
let _liveOddsBusy = false;
const STALE_THRESHOLD_MS = 35000;  // 35 seconds — disable odds if unchanged
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
// INIT — DB-backed (tables created automatically)
// ══════════════════════════════════════════

// ── Middleware ──
app.use(compression({ filter: (req, res) => {
  if (req.path === "/api/live-stream") return false;
  return compression.filter(req, res);
}}));
app.use(express.json());
app.use(auth.attachSession);
app.use(express.static(path.join(__dirname, "public")));

// ── /logout route: serve app.html which auto-detects and logs out ──
app.get("/logout", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

// ══════════════════════════════════════════
// HELPERS (DB-backed — see db.js)
// ══════════════════════════════════════════

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
app.post("/api/auth/login", async (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.json({ success: false, error: "Missing fields" });

  const adminId = process.env.ADMIN_ID || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "";
  // admin login is disabled (fails closed) until ADMIN_PASSWORD is set
  if (adminPass && id.toLowerCase() === adminId.toLowerCase() && auth.safeEqual(password, adminPass)) {
    auth.setSessionCookie(res, adminId.toLowerCase(), "admin");
    return res.json({ success: true, user: { id: adminId, displayName: "Admin", credits: 0, isAdmin: true } });
  }

  try {
    const user = await db.getUserById(id.toLowerCase());
    if (user && auth.verifyPassword(password, user.password)) {
      // re-hash passwords still stored in plaintext from before hashing was introduced
      if (!auth.isHashed(user.password)) await db.updateUserPassword(user.id, auth.hashPassword(password));
      auth.setSessionCookie(res, user.id, "user");
      res.json({ success: true, user: { id: user.id, displayName: user.displayName, credits: user.credits } });
    } else {
      res.json({ success: false, error: "Invalid credentials" });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: "Database error" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

app.get("/api/auth/me", auth.requireUser, (req, res) => {
  res.json({ success: true, user: { id: req.session.userId, isAdmin: req.session.role === "admin" } });
});

// ══════════════════════════════════════════
// USER ROUTES
// ══════════════════════════════════════════
app.get("/api/users", auth.requireAdmin, async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json(users.map(u => ({ id: u.id, displayName: u.displayName, credits: u.credits })));
  } catch (e) { res.status(500).json({ error: "Database error" }); }
});

app.post("/api/users", auth.requireAdmin, async (req, res) => {
  const { id, password, displayName } = req.body;
  if (!id || !password || !displayName) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }
  try {
    const existing = await db.getUserById(id.toLowerCase().trim());
    if (existing) return res.status(409).json({ success: false, error: "User already exists" });
    await db.createUser(id.toLowerCase().trim(), auth.hashPassword(password), displayName.trim());
    res.json({ success: true, user: { id: id.toLowerCase().trim(), displayName: displayName.trim(), credits: 0 } });
  } catch (e) { res.status(500).json({ success: false, error: "Database error" }); }
});

app.delete("/api/users/:id", auth.requireAdmin, async (req, res) => {
  try {
    const deleted = await db.deleteUser(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: "Database error" }); }
});

app.post("/api/users/:id/credits", auth.requireAdmin, async (req, res) => {
  const { action, amount } = req.body;
  try {
    const user = await db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const amt = parseFloat(amount) || 0;
    if (amt < 0) return res.status(400).json({ success: false, error: "Amount must be positive" });

    let newCredits;
    if (action === "add") newCredits = user.credits + amt;
    else if (action === "subtract") newCredits = Math.max(0, user.credits - amt);
    else if (action === "set") newCredits = Math.max(0, amt);
    else return res.status(400).json({ success: false, error: "Invalid action (add|subtract|set)" });

    await db.updateUserCredits(req.params.id, newCredits);
    res.json({ success: true, credits: newCredits });
  } catch (e) { res.status(500).json({ success: false, error: "Database error" }); }
});

app.get("/api/users/:id", auth.requireSelfOrAdmin("id"), async (req, res) => {
  try {
    const user = await db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ success: false });
    res.json({ id: user.id, displayName: user.displayName, credits: user.credits });
  } catch (e) { res.status(500).json({ success: false }); }
});

// ── Stake, cost and payout of a new bet, computed on the server ──
// The browser's own totals are ignored so nobody can send a negative stake or inflate the payout.
function quoteBet({ selections, stake, mode }) {
  const betMode = mode || "combined";
  if (!["combined", "system"].includes(betMode)) return { error: "Invalid bet mode" };
  const amount = Number(stake);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Stake must be a positive amount" };
  const odds = selections.map((s) => Number(s && s.odd));
  if (odds.some((o) => !Number.isFinite(o) || o < 1)) return { error: "Invalid odds" };

  const round = (n) => Math.round(n * 100) / 100;
  if (betMode === "system") {
    return {
      mode: betMode,
      stake: amount,
      totalCost: round(amount * odds.length),
      totalOdds: 0,
      possibleWin: round(odds.reduce((sum, o) => sum + amount * o, 0)),
    };
  }
  const totalOdds = odds.reduce((acc, o) => acc * o, 1);
  return { mode: betMode, stake: amount, totalCost: amount, totalOdds: round(totalOdds), possibleWin: round(amount * totalOdds) };
}

// ══════════════════════════════════════════
// BET ROUTES
// ══════════════════════════════════════════
app.post("/api/bets", auth.requireUser, async (req, res) => {
  // bets are always placed for the logged-in user, never for an id sent by the browser
  const userId = req.session.userId;
  const { selections, stake, totalOdds, mode } = req.body;
  if (req.session.role === "admin") {
    return res.status(403).json({ success: false, error: "Admins cannot place bets" });
  }
  if (!Array.isArray(selections) || selections.length === 0 || !stake || (totalOdds == null && !mode)) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  // Reject bets on finished matches or suspended/stale odds
  for (const sel of selections) {
    const match = matches.find(m => m.id === sel.matchId);
    if (match && (FINISHED_SHORT.has(match.statusShort) || SETTLED_STATUSES_BET.has(match.status))) {
      return res.status(400).json({ success: false, error: "Match already finished: " + (match.home?.name || sel.matchId) + " vs " + (match.away?.name || "") });
    }
    if (match && LIVE_SHORT.has(match.statusShort)) {
      const liveItem = currentLiveOdds.find(o => o.fixtureId === sel.matchId);
      if (liveItem) {
        const liveBet = (liveItem.odds || []).find(b => b.id === sel.betId);
        const liveVal = liveBet && (liveBet.values || []).find(v => v.value === sel.pick);
        if (!liveVal || liveVal.suspended) {
          return res.status(400).json({ success: false, error: "Odds suspended for this selection" });
        }
      }
    }
  }

  const quote = quoteBet({ selections, stake, mode });
  if (quote.error) return res.status(400).json({ success: false, error: quote.error });

  const bet = {
    id: "FB" + Date.now().toString(36).toUpperCase(),
    userId,
    timestamp: new Date().toISOString(),
    mode: quote.mode,
    selections,
    stake: quote.stake,
    totalOdds: quote.totalOdds,
    possibleWin: quote.possibleWin,
  };
  const totalCost = quote.totalCost;

  try {
    const result = await db.placeBetTransaction(userId, totalCost, bet);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, bet: { id: bet.id, status: "pending" }, credits: result.credits });
  } catch (e) {
    console.error("[BET] Error:", e.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

app.get("/api/bets/:userId", auth.requireSelfOrAdmin("userId"), async (req, res) => {
  try {
    const bets = await db.getBetsByUser(req.params.userId);
    res.json(bets);
  } catch (e) { res.status(500).json([]); }
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
app.post("/api/fetch/daily", auth.requireAdmin, async (req, res) => {
  try { await dailyRefresh(); res.json({ success: true, matchCount: matches.length }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post("/api/fetch/prematch", auth.requireAdmin, async (req, res) => {
  try { await refreshPreMatchOdds(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post("/api/settle", auth.requireAdmin, async (req, res) => {
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

  // Halftime score — try match data first, fall back to deriving from events
  let ht = match.htScore || null;
  if (!ht && match.events && match.events.goals) {
    // Derive HT score from goal events (goals scored at minute <= 45)
    let htDerH = 0, htDerA = 0;
    for (const g of match.events.goals) {
      if (g.minute <= 45) {
        if (g.teamId === match.home?.id) htDerH++; else htDerA++;
      }
    }
    ht = { home: htDerH, away: htDerA };
  }
  const htH = ht ? ht.home : null;
  const htA = ht ? ht.away : null;
  const htTotal = ht !== null && htH !== null ? htH + htA : null;
  // Second half derived from FT - HT
  const h2H = htH !== null ? h - htH : null;
  const h2A = htA !== null ? a - htA : null;
  const h2Total = h2H !== null ? (h2H + h2A) : null;

  // ── Helper: evaluate Over/Under pick ──
  function evalOU(goalCount, pickStr) {
    // Handle "No Goal" pick (= 0 goals)
    if (/^no goal$/i.test(pickStr)) return goalCount === 0 ? "won" : "lost";
    // Handle exact number picks like "1", "2", "3+"
    const exact = parseInt(pickStr);
    if (/^\d+$/.test(pickStr) && !isNaN(exact)) return goalCount === exact ? "won" : "lost";
    if (/^\d+\+$/.test(pickStr)) { const min = parseInt(pickStr); return goalCount >= min ? "won" : "lost"; }
    // Standard Over/Under
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

  // ═══ NAME-BASED EVALUATION (live bets use different IDs than pre-match) ═══
  // If the bet has a marketLabel, try name-based matching FIRST
  const name = (sel.marketLabel || "").toLowerCase();
  if (name) {
    const nameResult = evaluateByName(name, pick, h, a, total, ht, htH, htA, htTotal, h2H, h2A, h2Total, match, evalOU, evalResult, evalAsianHandicap);
    if (nameResult !== null) return nameResult;
  }

  // ═══ FULL-TIME BETS — ID-BASED (Bet365 pre-match IDs) ═══

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

  // ═══ ID-BASED FALLBACK (pre-match Bet365 bets without marketLabel match) ═══
  return "void";
}

// ── Name-based settlement (handles live bets with different IDs) ──
function evaluateByName(name, pick, h, a, total, ht, htH, htA, htTotal, h2H, h2A, h2Total, match, evalOU, evalResult, evalAsianHandicap) {
  if (!name) return null;

  // ═══ EVENT-BASED BETS (need match.events with goal data) ═══
  const ev = match.events;
  const goals = ev ? ev.goals || [] : [];
  const homeId = match.home?.id;
  const awayId = match.away?.id;

  // 1x2 at N minutes — compute score at that minute
  if (/\b1x2\s*-\s*(\d+)\s*min/i.test(name)) {
    if (!ev) return null; // wait for events data
    const minMatch = name.match(/1x2\s*-\s*(\d+)\s*min/i);
    const targetMin = parseInt(minMatch[1]);
    let hAtMin = 0, aAtMin = 0;
    goals.forEach(g => { if (g.minute <= targetMin) { if (g.teamId === homeId) hAtMin++; else aAtMin++; } });
    return evalResult(hAtMin, aAtMin, pick);
  }

  // Goal in interval — check first goal minute
  if (/\bgoal in interval\b/i.test(name)) {
    if (!ev) return null;
    // Pick format: "0-10", "11-20", "21-30", etc. or "No Goal"
    const isAway = /\baway\b/i.test(name);
    const relevantGoals = isAway ? goals.filter(g => g.teamId === awayId) : goals;
    const firstGoal = relevantGoals[0];
    if (/no goal/i.test(pick)) return relevantGoals.length === 0 ? "won" : "lost";
    const rangeMatch = pick.match(/(\d+)\s*-\s*(\d+)/);
    if (rangeMatch && firstGoal) {
      const lo = parseInt(rangeMatch[1]);
      const hi = parseInt(rangeMatch[2]);
      return (firstGoal.minute >= lo && firstGoal.minute <= hi) ? "won" : "lost";
    }
    if (rangeMatch && !firstGoal) return "lost"; // no goal at all
    return "void";
  }

  // Goal Scorer / Anytime Goal Scorer
  if (/\bgoal scorer\b/i.test(name)) {
    if (!ev) return null;
    // Pick is a player name — fuzzy match against goal events (exclude own goals)
    const pickLower = pick.toLowerCase().trim();
    const regularGoals = goals.filter(g => g.detail !== "Own Goal");
    const scored = regularGoals.some(g => {
      const pName = (g.player || "").toLowerCase();
      return pName === pickLower || pName.includes(pickLower) || pickLower.includes(pName);
    });
    if (/\bno goal/i.test(pick)) return regularGoals.length === 0 ? "won" : "lost";
    return scored ? "won" : "lost";
  }

  // "To Qualify" — void (tournament context, can't determine from single match)
  if (/\bto qualify\b/i.test(name)) return "void";

  // "To Score 2 or More" — player scored 2+ goals (exclude own goals)
  if (/\bto score \d+ or more\b/i.test(name)) {
    if (!ev) return null;
    const pickLower = pick.toLowerCase().trim();
    if (/\bno\b/i.test(pick) || /\bnone\b/i.test(pick)) return "void";
    const playerGoals = goals.filter(g => {
      if (g.detail === "Own Goal") return false;
      const pName = (g.player || "").toLowerCase();
      return pName === pickLower || pName.includes(pickLower) || pickLower.includes(pName);
    }).length;
    const numMatch = name.match(/to score (\d+) or more/i);
    const target = numMatch ? parseInt(numMatch[1]) : 2;
    return playerGoals >= target ? "won" : "lost";
  }

  // "Which team will score the Nth goal?"
  if (/\bwhich team.*score.*(\d+).*goal\b/i.test(name)) {
    if (!ev) return null;
    const nMatch = name.match(/(\d+)(?:st|nd|rd|th)?\s*goal/i);
    const n = nMatch ? parseInt(nMatch[1]) : 1;
    if (goals.length < n) {
      // Nth goal never scored
      return (/no goal|neither/i.test(pick)) ? "won" : "lost";
    }
    const nthGoal = goals[n - 1];
    if (pick === "Home" || pick === "1") return nthGoal.teamId === homeId ? "won" : "lost";
    if (pick === "Away" || pick === "2") return nthGoal.teamId === awayId ? "won" : "lost";
    return "void";
  }
  // "Result / Both Teams To Score" — combo market (e.g., "Home & Yes"), complex evaluation
  if (/\bresult.*both teams/i.test(name)) {
    const both = h > 0 && a > 0;
    // Picks like "Home & Yes", "Away & No", "Draw & Yes" etc.
    if (/home.*yes/i.test(pick)) return (h > a && both) ? "won" : "lost";
    if (/home.*no/i.test(pick)) return (h > a && !both) ? "won" : "lost";
    if (/away.*yes/i.test(pick)) return (a > h && both) ? "won" : "lost";
    if (/away.*no/i.test(pick)) return (a > h && !both) ? "won" : "lost";
    if (/draw.*yes/i.test(pick)) return (h === a && both) ? "won" : "lost";
    if (/draw.*no/i.test(pick)) return (h === a && !both) ? "won" : "lost";
    return "void"; // unknown pick format
  }
  // "Away/Home Team to Score in Both Halves" — need HT data
  if (/\bscore.*both halves/i.test(name) || /\bboth halves/i.test(name)) {
    if (!ht) return null;
    if (/\baway\b/i.test(name)) {
      const scored1st = htA > 0;
      const scored2nd = h2A > 0;
      return pick === "Yes" ? (scored1st && scored2nd ? "won" : "lost") : (!scored1st || !scored2nd ? "won" : "lost");
    }
    if (/\bhome\b/i.test(name)) {
      const scored1st = htH > 0;
      const scored2nd = h2H > 0;
      return pick === "Yes" ? (scored1st && scored2nd ? "won" : "lost") : (!scored1st || !scored2nd ? "won" : "lost");
    }
    return "void";
  }

  // ═══ FIRST HALF bets (check before full-time to prevent wrong match) ═══
  if (/\b(1st half|first half|\(1st half\))\b/i.test(name)) {
    if (ht === null) return null; // wait for HT data
    if (/\b(1x2|match winner|winner|result)\b/i.test(name)) return evalResult(htH, htA, pick);
    if (/\b(over.?under|goals?|total)\b/i.test(name)) return evalOU(htTotal, pick);
    if (/\basian handicap\b/i.test(name)) return evalAsianHandicap(htH, htA, pick);
    if (/\beuropean handicap\b/i.test(name)) {
      const m3 = pick.match(/^(Home|Draw|Away)\s+([+-]?\d+\.?\d*)$/);
      if (m3) {
        const line = parseFloat(m3[2]);
        if (line < 0) return evalResult(htH, htA + line, m3[1]);
        else return evalResult(htH + line, htA, m3[1]);
      }
    }
    if (/\bdraw no bet\b/i.test(name)) {
      if (pick === "Home") return htH > htA ? "won" : htH === htA ? "void" : "lost";
      if (pick === "Away") return htA > htH ? "won" : htH === htA ? "void" : "lost";
    }
    if (/\bboth teams?.*(score|goal)\b/i.test(name)) {
      const both = htH > 0 && htA > 0;
      return pick === "Yes" ? (both ? "won" : "lost") : (!both ? "won" : "lost");
    }
    // Corner/card 1st half — void (no half-specific stats)
    if (/corner|card/i.test(name)) return "void";
    return "void";
  }

  // ═══ SECOND HALF bets ═══
  if (/\b(2nd half|second half|\(2nd half\))\b/i.test(name) || /\bto win 2nd half\b/i.test(name)) {
    if (ht === null || h2H === null) return null; // wait for HT data
    if (/\b(1x2|match winner|winner|result|to win)\b/i.test(name)) return evalResult(h2H, h2A, pick);
    if (/\b(over.?under|goals?|total)\b/i.test(name)) return evalOU(h2Total, pick);
    if (/\bboth teams?.*(score|goal)\b/i.test(name)) {
      const both = h2H > 0 && h2A > 0;
      return pick === "Yes" ? (both ? "won" : "lost") : (!both ? "won" : "lost");
    }
    if (/corner|card/i.test(name)) return "void";
    return "void";
  }

  // ═══ FULL-TIME result bets ═══
  if (/\b(1x2|match winner|fulltime result)\b/i.test(name) && !/half/i.test(name)) return evalResult(h, a, pick);
  if (/\bdraw no bet\b/i.test(name)) {
    if (pick === "Home") return h > a ? "won" : h === a ? "void" : "lost";
    if (pick === "Away") return a > h ? "won" : h === a ? "void" : "lost";
  }
  if (/\bdouble chance\b/i.test(name)) {
    if (pick === "Home or Draw") return h >= a ? "won" : "lost";
    if (pick === "Home or Away") return h !== a ? "won" : "lost";
    if (pick === "Away or Draw" || pick === "Draw or Away") return a >= h ? "won" : "lost";
  }

  // ═══ Final Score / Correct Score ═══
  if (/\b(final score|correct score)\b/i.test(name) && !/half/i.test(name)) {
    // Pick format: "1:0", "2:1", etc.
    return pick === h + ":" + a ? "won" : "lost";
  }
  if (/\b(final score|correct score).*(1st|first) half\b/i.test(name) || /\bcorrect score.*\(1st/i.test(name)) {
    if (!ht) return null;
    return pick === htH + ":" + htA ? "won" : "lost";
  }

  // ═══ Half Time / Full Time ═══
  if (/\bhalf.*time.*full.*time\b/i.test(name)) {
    if (!ht) return null;
    const htResult = htH > htA ? "Home" : htH === htA ? "Draw" : "Away";
    const ftResult = h > a ? "Home" : h === a ? "Draw" : "Away";
    // Pick format: "Home/Home", "Draw/Away", etc.
    const expected = htResult + "/" + ftResult;
    return pick === expected ? "won" : "lost";
  }

  // ═══ Last Team to Score (3 way) ═══
  if (/\blast team.*score\b/i.test(name)) {
    if (!ev) return null;
    if (goals.length === 0) return (/no goal|neither/i.test(pick)) ? "won" : "lost";
    const lastGoal = goals[goals.length - 1];
    if (pick === "Home" || pick === "1") return lastGoal.teamId === homeId ? "won" : "lost";
    if (pick === "Away" || pick === "2") return lastGoal.teamId === awayId ? "won" : "lost";
    if (/no goal|neither/i.test(pick)) return "lost"; // there were goals
    return "void";
  }

  // ═══ Team Score a Goal in 2nd Half ═══
  if (/\b(home|away).*score.*goal.*2nd half\b/i.test(name) || /\b(home|away).*score.*goal.*\(2nd/i.test(name)) {
    if (!ht) return null;
    const isAway = /away/i.test(name);
    const scored2nd = isAway ? h2A > 0 : h2H > 0;
    return pick === "Yes" ? (scored2nd ? "won" : "lost") : (!scored2nd ? "won" : "lost");
  }

  // ═══ Goals Over/Under ═══
  if (/\b(match goals|over.?under line|over.?under)\b/i.test(name) && !/corner|card|shot|half/i.test(name)) return evalOU(total, pick);
  // "How many goals will Away/Home Team score?" — team-specific
  if (/\bhow many goals.*away\b/i.test(name)) return evalOU(a, pick);
  if (/\bhow many goals.*home\b/i.test(name)) return evalOU(h, pick);
  if (/\bhow many goals\b/i.test(name)) return evalOU(total, pick);
  if (/\bhome.*(goals?|total)\b/i.test(name) && !/corner|card|shot|half/i.test(name)) return evalOU(h, pick);
  if (/\baway.*(goals?|total)\b/i.test(name) && !/corner|card|shot|half|interval/i.test(name)) return evalOU(a, pick);

  // ═══ Both Teams Score (full-time) ═══
  if (/\bboth teams?.*(score|goal)\b/i.test(name)) {
    const both = h > 0 && a > 0;
    return pick === "Yes" ? (both ? "won" : "lost") : (!both ? "won" : "lost");
  }

  // ═══ Odd/Even ═══
  if (/\bodd.?even\b/i.test(name)) {
    return pick === "Odd" ? (total % 2 !== 0 ? "won" : "lost") : (total % 2 === 0 ? "won" : "lost");
  }

  // ═══ Asian Handicap (full-time) ═══
  if (/\basian handicap\b/i.test(name)) return evalAsianHandicap(h, a, pick);

  // ═══ European Handicap / 3-Way Handicap (full-time) ═══
  if (/\b(3.?way handicap|european handicap)\b/i.test(name)) {
    const m3 = pick.match(/^(Home|Draw|Away)\s+([+-]?\d+\.?\d*)$/);
    if (m3) {
      const line = parseFloat(m3[2]);
      if (line < 0) return evalResult(h, a + line, m3[1]);
      else return evalResult(h + line, a, m3[1]);
    }
  }

  // ═══ Exact Goals ═══
  if (/\bexact.*(goals?|number)\b/i.test(name)) {
    const num = parseInt(pick);
    if (!isNaN(num)) return total === num ? "won" : "lost";
    if (/no goal/i.test(pick)) return total === 0 ? "won" : "lost";
    if (pick.includes("+") || /or more/i.test(pick)) {
      const min = parseInt(pick); if (!isNaN(min)) return total >= min ? "won" : "lost";
    }
  }

  // ═══ STATISTICS-BASED BETS (corners, cards, shots) ═══
  if (/corner|card|shot/i.test(name)) {
    const st = match.stats;
    if (!st || !st.home || !st.away) return "void";

    const totalCorners = st.totalCorners;
    const homeCorners = st.home.corners;
    const awayCorners = st.away.corners;
    const totalCards = st.totalCards;
    const homeCards = st.home.totalCards;
    const awayCards = st.away.totalCards;
    const totalShots = st.totalShotsOnGoal;
    const homeShots = st.home.shotsOnGoal;
    const awayShots = st.away.shotsOnGoal;

    // Corner O/U
    if (/\b(total|match).*corner/i.test(name) && !/3.?way|1st|2nd|half/i.test(name)) return evalOU(totalCorners, pick);
    if (/\btotal corners\b/i.test(name) && !/3.?way|1st|2nd|half/i.test(name)) return evalOU(totalCorners, pick);
    if (/\bhome.*corner/i.test(name)) return evalOU(homeCorners, pick);
    if (/\baway.*corner/i.test(name)) return evalOU(awayCorners, pick);
    if (/\bcorner.*over.?under/i.test(name) || /\bcorner.*line/i.test(name)) return evalOU(totalCorners, pick);
    // Total Corners 3-way — just evaluate O/U, the 3-way part is in the pick
    if (/\btotal corners.*3.?way/i.test(name) && !/half/i.test(name)) return evalOU(totalCorners, pick);
    // Half-specific corner 3-way — can't evaluate without half stats
    if (/\btotal corners.*3.?way.*(1st|2nd|half)/i.test(name)) return "void";
    // Race to N corners
    if (/\brace to.*corner/i.test(name)) {
      const raceMatch = name.match(/race to (?:the )?(\d+)/i);
      if (raceMatch) {
        const target = parseInt(raceMatch[1]);
        if (pick === "Home" || pick === "1") return homeCorners >= target ? "won" : "lost";
        if (pick === "Away" || pick === "2") return awayCorners >= target ? "won" : "lost";
        if (/neither|no winner/i.test(pick)) return (homeCorners < target && awayCorners < target) ? "won" : "lost";
      }
    }
    // Which team Nth corner / Last corner — need event data, void
    if (/\bwhich team.*corner/i.test(name) || /\blast corner/i.test(name)) return "void";
    // Corner match result
    if (/\bcorner.*(match|result|winner)/i.test(name) || /\b(match|result).*corner/i.test(name)) {
      return evalResult(homeCorners, awayCorners, pick);
    }
    // Card bets
    if (/\b(total|match).*card/i.test(name)) return evalOU(totalCards, pick);
    if (/\bhome.*card/i.test(name)) return evalOU(homeCards, pick);
    if (/\baway.*card/i.test(name)) return evalOU(awayCards, pick);
    if (/\bcard.*over.?under/i.test(name) || /\bcard.*line/i.test(name)) return evalOU(totalCards, pick);
    // Shot bets
    if (/\b(total|match).*shot/i.test(name)) return evalOU(totalShots, pick);
    if (/\bhome.*shot/i.test(name)) return evalOU(homeShots, pick);
    if (/\baway.*shot/i.test(name)) return evalOU(awayShots, pick);
    if (/\bshot.*on.*goal/i.test(name)) return evalOU(totalShots, pick);
  }

  return null; // no name match — fall through to ID-based
}

// ── Payout calculation for a bet whose selections all have a result ──
// combined: any lost → lost; void legs count as odds 1.0; all void → stake refunded
// system:   each selection is its own single bet of `stake`
function computeBetOutcome(bet) {
  let status, payout = 0, finalOdds = bet.totalOdds, finalWin = bet.possibleWin;

  if (bet.mode === "system") {
    let totalPayout = 0;
    let wonCount = 0, lostCount = 0, voidCount = 0;
    for (const sel of bet.selections) {
      if (sel.result === "won") { totalPayout += bet.stake * sel.odd; wonCount++; }
      else if (sel.result === "void") { totalPayout += bet.stake; voidCount++; }
      else { lostCount++; }
    }
    payout = Math.round(totalPayout * 100) / 100;
    finalWin = payout;
    if (wonCount === 0 && voidCount === 0) status = "lost";
    else if (wonCount === 0 && voidCount > 0 && lostCount === 0) status = "void";
    else status = wonCount > 0 ? "won" : "void";
  } else {
    const anyLost = bet.selections.some(s => s.result === "lost");
    const anyVoid = bet.selections.some(s => s.result === "void");
    if (anyLost) {
      status = "lost";
      payout = 0;
    } else if (anyVoid) {
      const allVoid = bet.selections.every(s => s.result === "void");
      if (allVoid) {
        status = "void";
        payout = bet.stake;
      } else {
        const adjustedOdds = bet.selections.reduce((acc, s) => acc * (s.result === "void" ? 1.0 : s.odd), 1.0);
        payout = Math.round(bet.stake * adjustedOdds * 100) / 100;
        status = "won";
        finalOdds = Math.round(adjustedOdds * 100) / 100;
        finalWin = payout;
      }
    } else {
      status = "won";
      payout = bet.possibleWin;
    }
  }

  return { status, payout, finalOdds, finalWin };
}

let _settleBusy = false;
async function settleBets() {
  if (_settleBusy) return { settled: 0 };
  _settleBusy = true;
  try { return await _settleBetsInner(); } finally { _settleBusy = false; }
}
async function _settleBetsInner() {
  const bets = await db.getPendingBets();
  if (matches.length === 0 || bets.length === 0) return { settled: 0 };

  // Fetch missing stats and events for finished matches with pending bets
  const finishedNeedData = new Set();
  for (const bet of bets) {
    for (const sel of bet.selections) {
      const match = matches.find(m => m.id === sel.matchId);
      if (match && SETTLED_STATUSES_BET.has(match.status) && (!match.stats || !match.events)) {
        finishedNeedData.add(sel.matchId);
      }
    }
  }
  for (const mid of finishedNeedData) {
    const match = matches.find(m => m.id === mid);
    if (!match) continue;
    if (!match.stats) {
      try {
        const stats = await fetchFixtureStatistics(mid);
        if (stats && stats.home && stats.away) {
          match.stats = stats;
          console.log(`[SETTLE] Fetched missing stats for ${mid}`);
        }
      } catch (e) { console.error(`[SETTLE] Stats fetch failed for ${mid}: ${e.message}`); }
    }
    if (!match.events) {
      try {
        const events = await fetchFixtureEvents(mid);
        if (events) {
          match.events = events;
          console.log(`[SETTLE] Fetched events for ${mid}: ${events.goals.length} goals`);
        }
      } catch (e) { console.error(`[SETTLE] Events fetch failed for ${mid}: ${e.message}`); }
    }
  }

  let settled = 0;

  for (const bet of bets) {
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

      let result = evaluateSelection(sel, match);
      if (result === null) {
        // Safety net: if match finished >30 min ago AND we already have events+stats, void it
        const matchDate = new Date(match.date || 0).getTime();
        const cutoff = Date.now() - 30 * 60 * 1000;
        const hasData = match.events && match.stats;
        if (matchDate < cutoff && hasData && SETTLED_STATUSES_BET.has(match.status)) {
          console.log(`[SETTLE] Force-voiding unevaluable selection: bet=${bet.id} match=${match.id} market="${sel.marketLabel || sel.betId}"`);
          result = "void";
        } else {
          allFinished = false; continue;
        }
      }
      sel.result = result;
      if (result === "void") anyVoid = true;
      else if (result === "lost") anyLost = true;
    }

    if (!allFinished) continue;

    const { status, payout, finalOdds, finalWin } = computeBetOutcome(bet);

    try {
      await db.settleBetTransaction(bet.id, status, finalWin, finalOdds, bet.selections, bet.userId, payout);
      settled++;
    } catch (e) {
      console.error(`[SETTLE] Failed to settle bet ${bet.id}: ${e.message}`);
    }
  }

  if (settled > 0) console.log(`[SETTLE] Settled ${settled} bet(s)`);
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
      db.saveMatches(matches).catch(e => console.error("[DB] saveMatches error:", e.message));
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
      db.saveMatches(matches).catch(e => console.error("[DB] saveMatches error:", e.message));
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
    await db.replaceAllMatches(matches);
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
      await db.saveMatches(matches);
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
function startServer() {
  return app.listen(PORT, async () => {
    console.log("=".repeat(50));
    console.log(`FantasyBet server running at http://localhost:${PORT}`);
    console.log("=".repeat(50));

    // Initialize database (create tables + migrate JSON if needed)
    try {
      await db.initDB();
      const dbMatches = await db.loadMatches();
      if (dbMatches.length > 0) {
        matches = dbMatches;
        lastMatchUpdate = new Date().toISOString();
        console.log(`[INIT] Loaded ${matches.length} matches from database`);
      }
    } catch (e) {
      console.error("[DB] Init failed:", e.message);
      console.error("Check DATABASE_URL environment variable");
    }

    if (!isApiKeyConfigured()) {
      console.log("API key not configured. Edit .env and set API_FOOTBALL_KEY");
      console.log("The site will work with mock data until then.\n");
    } else {
      console.log("API key configured. Starting real-time engine...\n");
    }

    startEngine();
  });
}

if (require.main === module) {
  startServer();
}

// test hook: lets tests seed the in-memory match state
function __setState(state) {
  if (state.matches) matches = state.matches;
  if (state.currentLiveOdds) currentLiveOdds = state.currentLiveOdds;
}

module.exports = { app, startServer, evaluateSelection, computeBetOutcome, quoteBet, settleBets, __setState };
