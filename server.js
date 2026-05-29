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

// ── CRON SCHEDULES ──

// Full refresh (fixtures + odds) every 4 hours: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00
cron.schedule("0 0,4,8,12,16,20 * * *", () => {
  console.log("\n[CRON] Full refresh (fixtures + odds)");
  fullRefresh().catch(console.error);
});

// Odds update for 24h fixtures — every 5 minutes
cron.schedule("*/5 * * * *", () => {
  console.log("\n[CRON] Odds update (24h fixtures)");
  oddsUpdate24h().catch(console.error);
});

// Odds update for extended fixtures — every 15 minutes
cron.schedule("*/15 * * * *", () => {
  console.log("\n[CRON] Odds update (extended fixtures)");
  oddsUpdateExtended().catch(console.error);
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
    fullRefresh().catch(console.error);
  }
});
