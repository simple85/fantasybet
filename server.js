// ============================================
// BETZONE SERVER
// ============================================
// Serves the frontend + runs scheduled data fetches
// Manages users and credits server-side
//
// Start: npm start

const express = require("express");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
require("dotenv").config();

const { fullRefresh, oddsUpdate24h, oddsUpdateExtended } = require("./fetch-data");

const app = express();
const PORT = process.env.PORT || 8000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "matches.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const BETS_FILE = path.join(DATA_DIR, "bets.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize users file if not exists
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([
    { id: "ali", password: "ali123", displayName: "Ali Yilmaz", credits: 0 },
    { id: "mehmet", password: "mehmet123", displayName: "Mehmet Demir", credits: 0 },
    { id: "ayse", password: "ayse123", displayName: "Ayse Kaya", credits: 0 },
    { id: "emre", password: "emre123", displayName: "Emre Celik", credits: 0 },
    { id: "zeynep", password: "zeynep123", displayName: "Zeynep Arslan", credits: 0 },
  ], null, 2));
}

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Helper: read/write users ──
function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch (e) {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── Helper: read/write bets ──
function readBets() {
  try {
    if (fs.existsSync(BETS_FILE)) return JSON.parse(fs.readFileSync(BETS_FILE, "utf-8"));
  } catch (e) {}
  return [];
}

function writeBets(bets) {
  fs.writeFileSync(BETS_FILE, JSON.stringify(bets, null, 2));
}

function loadMatchData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      return data.matches || [];
    }
  } catch (e) {}
  return [];
}

// ── Auth: login ──
app.post("/api/auth/login", (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.json({ success: false, error: "Missing fields" });

  // Check admin credentials from .env
  const adminId = process.env.ADMIN_ID || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "";
  if (id.toLowerCase() === adminId.toLowerCase() && password === adminPass) {
    return res.json({ success: true, user: { id: adminId, displayName: "Admin", credits: 0, isAdmin: true } });
  }

  // Check regular users
  const users = readUsers();
  const user = users.find(u => u.id.toLowerCase() === id.toLowerCase() && u.password === password);
  if (user) {
    res.json({ success: true, user: { id: user.id, displayName: user.displayName, credits: user.credits } });
  } else {
    res.json({ success: false, error: "Invalid credentials" });
  }
});

// ── Users: list (returns without passwords) ──
app.get("/api/users", (req, res) => {
  const users = readUsers();
  res.json(users.map(u => ({ id: u.id, displayName: u.displayName, credits: u.credits })));
});

// ── Users: create ──
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

// ── Users: delete ──
app.delete("/api/users/:id", (req, res) => {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: "User not found" });
  users.splice(idx, 1);
  writeUsers(users);
  res.json({ success: true });
});

// ── Users: update credits ──
app.post("/api/users/:id/credits", (req, res) => {
  const { action, amount } = req.body;
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, error: "User not found" });

  const amt = parseFloat(amount) || 0;
  if (amt < 0) return res.status(400).json({ success: false, error: "Amount must be positive" });

  if (action === "add") {
    user.credits += amt;
  } else if (action === "subtract") {
    user.credits = Math.max(0, user.credits - amt);
  } else if (action === "set") {
    user.credits = Math.max(0, amt);
  } else {
    return res.status(400).json({ success: false, error: "Invalid action (add|subtract|set)" });
  }
  writeUsers(users);
  res.json({ success: true, credits: user.credits });
});

// ── Users: get single user (for refreshing credits) ──
app.get("/api/users/:id", (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false });
  res.json({ id: user.id, displayName: user.displayName, credits: user.credits });
});

// ── Bets: create ──
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

// ── Bets: list for user ──
app.get("/api/bets/:userId", (req, res) => {
  const bets = readBets();
  res.json(bets.filter(b => b.userId === req.params.userId));
});

// ── API: match data ──
app.get("/api/matches", (req, res) => {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      res.json(JSON.parse(raw));
    } else {
      res.json({ lastUpdated: null, matchCount: 0, matches: [] });
    }
  } catch (err) {
    console.error("Error reading match data:", err.message);
    res.status(500).json({ error: "Failed to load match data" });
  }
});

// ── API: server status ──
app.get("/api/status", (req, res) => {
  let lastUpdated = null;
  let matchCount = 0;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      lastUpdated = data.lastUpdated;
      matchCount = data.matchCount;
    }
  } catch (e) {}
  res.json({
    status: "running",
    lastUpdated,
    matchCount,
    apiKeyConfigured: !!process.env.API_FOOTBALL_KEY && process.env.API_FOOTBALL_KEY.length > 5,
  });
});

// ── API: manual triggers ──
app.post("/api/fetch/full", async (req, res) => {
  try { await fullRefresh(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post("/api/fetch/odds24", async (req, res) => {
  try { await oddsUpdate24h(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post("/api/fetch/oddsext", async (req, res) => {
  try { await oddsUpdateExtended(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── BET SETTLEMENT ──
const SETTLED_STATUSES_BET = new Set(["Match Finished", "After Extra Time", "After Penalty"]);
const VOID_STATUSES_BET = new Set(["Match Postponed", "Match Cancelled", "Match Abandoned"]);

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
  // Goals Over/Under (5) / Goal Line (50)
  if (betId === 5 || betId === 50) {
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
  const matchData = loadMatchData();
  if (matchData.length === 0 || bets.length === 0) return { settled: 0 };

  let settled = 0;
  const users = readUsers();

  for (const bet of bets) {
    if (bet.status !== "pending") continue;

    let allFinished = true;
    let anyLost = false;
    let anyVoid = false;

    for (const sel of bet.selections) {
      const match = matchData.find(m => m.id === sel.matchId);
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
      // Void: refund stake
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
      // All selections won
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
    console.log("[SETTLE] Settled " + settled + " bet(s)");
  }
  return { settled };
}

// ── API: manual settle trigger ──
app.post("/api/settle", (req, res) => {
  const result = settleBets();
  res.json({ success: true, ...result });
});

// ── CRON SCHEDULES ──

// Full refresh (fixtures + odds) every 4 hours + settle bets
cron.schedule("0 0,4,8,12,16,20 * * *", () => {
  console.log("\n[CRON] Full refresh (fixtures + odds)");
  fullRefresh().then(() => settleBets()).catch(console.error);
});

// Odds update for 24h fixtures — every 5 minutes + settle bets
cron.schedule("*/5 * * * *", () => {
  console.log("\n[CRON] Odds update (24h fixtures)");
  oddsUpdate24h().then(() => settleBets()).catch(console.error);
});

// Odds update for extended fixtures — every 15 minutes + settle bets
cron.schedule("*/15 * * * *", () => {
  console.log("\n[CRON] Odds update (extended fixtures)");
  oddsUpdateExtended().then(() => settleBets()).catch(console.error);
});

// ── START ──
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`BetZone server running at http://localhost:${PORT}`);
  console.log("=".repeat(50));

  const keySet = process.env.API_FOOTBALL_KEY && process.env.API_FOOTBALL_KEY.length > 5;
  if (!keySet) {
    console.log("API key not configured. Edit .env and set API_FOOTBALL_KEY");
    console.log("The site will work with mock data until then.\n");
  } else {
    console.log("API key configured. Running initial data fetch...\n");
    fullRefresh().then(() => settleBets()).catch(console.error);
  }
});
