// ============================================
// FANTASYBET DATABASE MODULE (PostgreSQL)
// ============================================
// Replaces JSON file storage with PostgreSQL.
// Tables are created automatically on first connect.
// One-time migration reads old JSON files from disk if tables are empty.

const { Pool } = require("pg");
const { hashPassword } = require("./auth");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const BETS_FILE = path.join(DATA_DIR, "bets.json");
const MATCHES_FILE = path.join(DATA_DIR, "matches.json");

// ── Connection Pool ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

// ── Schema Creation ──
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        display_name TEXT NOT NULL,
        credits DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        selections JSONB NOT NULL,
        stake DOUBLE PRECISION NOT NULL,
        mode TEXT NOT NULL DEFAULT 'combined',
        total_odds DOUBLE PRECISION,
        possible_win DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'pending',
        settled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets(user_id);
      CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
      CREATE INDEX IF NOT EXISTS idx_bets_created_at ON bets(created_at DESC);

      -- Live bets the integrity guard refused (see integrity.js); repeated attempts are a signal
      CREATE TABLE IF NOT EXISTS integrity_events (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        fixture_id INTEGER,
        rule TEXT NOT NULL,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_integrity_events_user ON integrity_events(user_id, created_at DESC);

      -- Written by the offline detection (ml/integrity): one row per user per scoring run
      CREATE TABLE IF NOT EXISTS integrity_flags (
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        score DOUBLE PRECISION NOT NULL,
        flagged BOOLEAN NOT NULL,
        reasons JSONB NOT NULL,
        features JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_integrity_flags_run ON integrity_flags(run_id);

      -- One row per bet-builder (LLM) call: tokens, cost and latency
      CREATE TABLE IF NOT EXISTS bet_builder_usage (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd DOUBLE PRECISION NOT NULL,
        latency_ms INTEGER NOT NULL,
        outcome TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_bet_builder_usage_user ON bet_builder_usage(user_id, created_at DESC);
    `);
    console.log("[DB] Tables ready");

    // One-time migration from JSON files
    await migrateFromJSON(client);
  } finally {
    client.release();
  }
}

// ── One-time Migration from JSON files ──
async function migrateFromJSON(client) {
  // Check if users table is empty
  const { rows } = await client.query("SELECT COUNT(*) FROM users");
  if (parseInt(rows[0].count) > 0) {
    console.log("[DB] Data already exists, skipping migration");
    return;
  }

  console.log("[DB] Tables empty — migrating from JSON files...");

  // Migrate users from JSON, or seed defaults for fresh installs
  let usersSeeded = false;
  try {
    if (fs.existsSync(USERS_FILE)) {
      const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
      for (const u of users) {
        await client.query(
          "INSERT INTO users (id, password, display_name, credits) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
          [u.id, u.password, u.displayName || u.display_name || u.id, u.credits || 0]
        );
      }
      console.log(`[DB] Migrated ${users.length} users`);
      usersSeeded = true;
    }
  } catch (e) {
    console.error("[DB] User migration error:", e.message);
  }

  if (!usersSeeded) {
    const defaults = [
      { id: "ali", password: "ali123", name: "Ali Yilmaz" },
      { id: "max", password: "max123", name: "Max Richter" },
      { id: "james", password: "james123", name: "James Cole" },
      { id: "emre", password: "emre123", name: "Emre Celik" },
      { id: "lena", password: "lena123", name: "Lena Weber" },
    ];
    for (const u of defaults) {
      await client.query(
        "INSERT INTO users (id, password, display_name, credits) VALUES ($1, $2, $3, 0) ON CONFLICT (id) DO NOTHING",
        [u.id, hashPassword(u.password), u.name]
      );
    }
    console.log(`[DB] Seeded ${defaults.length} default users`);
  }

  // Migrate bets
  try {
    if (fs.existsSync(BETS_FILE)) {
      const bets = JSON.parse(fs.readFileSync(BETS_FILE, "utf-8"));
      let migrated = 0, skipped = 0;
      for (const b of bets) {
        try {
          await client.query(
            `INSERT INTO bets (id, user_id, selections, stake, mode, total_odds, possible_win, status, settled_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
            [
              b.id,
              b.userId,
              JSON.stringify(b.selections),
              b.stake,
              b.mode || "combined",
              b.totalOdds || null,
              b.possibleWin || null,
              b.status || "pending",
              b.settledAt || null,
              b.timestamp || new Date().toISOString(),
          ]
          );
          migrated++;
        } catch (e) {
          skipped++;
        }
      }
      console.log(`[DB] Migrated ${migrated} bets (skipped ${skipped} with missing users)`);
    }
  } catch (e) {
    console.error("[DB] Bet migration error:", e.message);
  }

  // Migrate matches
  try {
    if (fs.existsSync(MATCHES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MATCHES_FILE, "utf-8"));
      const matchList = raw.matches || raw;
      for (const m of matchList) {
        await client.query(
          "INSERT INTO matches (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO NOTHING",
          [m.id, JSON.stringify(m)]
        );
      }
      console.log(`[DB] Migrated ${matchList.length} matches`);
    }
  } catch (e) {
    console.error("[DB] Match migration error:", e.message);
  }
}

// ══════════════════════════════════════════
// USER QUERIES
// ══════════════════════════════════════════
async function getUsers() {
  const { rows } = await pool.query("SELECT id, password, display_name, credits FROM users ORDER BY id");
  return rows.map(r => ({ id: r.id, password: r.password, displayName: r.display_name, credits: r.credits }));
}

async function getUserById(id) {
  const { rows } = await pool.query("SELECT id, password, display_name, credits FROM users WHERE id = $1", [id]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: r.id, password: r.password, displayName: r.display_name, credits: r.credits };
}

async function createUser(id, password, displayName) {
  await pool.query(
    "INSERT INTO users (id, password, display_name, credits) VALUES ($1, $2, $3, 0)",
    [id, password, displayName]
  );
}

async function updateUserPassword(id, passwordHash) {
  await pool.query("UPDATE users SET password = $1 WHERE id = $2", [passwordHash, id]);
}

async function deleteUser(id) {
  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [id]);
  return rowCount > 0;
}

async function updateUserCredits(id, credits) {
  await pool.query("UPDATE users SET credits = $1 WHERE id = $2", [credits, id]);
}

// ══════════════════════════════════════════
// BET QUERIES
// ══════════════════════════════════════════
async function getBetsByUser(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM bets WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  return rows.map(mapBetRow);
}

async function getPendingBets() {
  const { rows } = await pool.query("SELECT * FROM bets WHERE status = 'pending'");
  return rows.map(mapBetRow);
}

async function createBet(bet) {
  await pool.query(
    `INSERT INTO bets (id, user_id, selections, stake, mode, total_odds, possible_win, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
    [bet.id, bet.userId, JSON.stringify(bet.selections), bet.stake, bet.mode, bet.totalOdds, bet.possibleWin, bet.timestamp]
  );
}

async function settleBet(betId, status, possibleWin, totalOdds, selections) {
  await pool.query(
    `UPDATE bets SET status = $1, possible_win = $2, total_odds = $3, selections = $4, settled_at = NOW() WHERE id = $5`,
    [status, possibleWin, totalOdds, JSON.stringify(selections), betId]
  );
}

// Atomic: deduct credits + create bet in one transaction
async function placeBetTransaction(userId, totalCost, bet) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock user row and check credits
    const { rows } = await client.query(
      "SELECT credits FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (rows.length === 0) { await client.query("ROLLBACK"); return { error: "User not found" }; }
    if (rows[0].credits < totalCost) { await client.query("ROLLBACK"); return { error: "Insufficient credits" }; }

    // Deduct credits
    await client.query("UPDATE users SET credits = credits - $1 WHERE id = $2", [totalCost, userId]);

    // Insert bet
    await client.query(
      `INSERT INTO bets (id, user_id, selections, stake, mode, total_odds, possible_win, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [bet.id, bet.userId, JSON.stringify(bet.selections), bet.stake, bet.mode, bet.totalOdds, bet.possibleWin, bet.timestamp]
    );

    await client.query("COMMIT");

    const updated = await client.query("SELECT credits FROM users WHERE id = $1", [userId]);
    return { success: true, credits: updated.rows[0].credits };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Atomic: settle bet + credit user in one transaction
async function settleBetTransaction(betId, status, possibleWin, totalOdds, selections, userId, payout) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE bets SET status = $1, possible_win = $2, total_odds = $3, selections = $4, settled_at = NOW() WHERE id = $5`,
      [status, possibleWin, totalOdds, JSON.stringify(selections), betId]
    );

    if (payout > 0) {
      await client.query("UPDATE users SET credits = credits + $1 WHERE id = $2", [payout, userId]);
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════
// MATCH QUERIES
// ══════════════════════════════════════════
async function loadMatches() {
  const { rows } = await pool.query("SELECT data FROM matches ORDER BY id");
  return rows.map(r => r.data);
}

async function saveMatches(matchList) {
  if (matchList.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Upsert all matches
    for (const m of matchList) {
      await client.query(
        `INSERT INTO matches (id, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
        [m.id, JSON.stringify(m)]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function replaceAllMatches(matchList) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM matches");
    for (const m of matchList) {
      await client.query(
        "INSERT INTO matches (id, data, updated_at) VALUES ($1, $2, NOW())",
        [m.id, JSON.stringify(m)]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── Helper: map DB row → bet object (matching old JSON format) ──
function mapBetRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    timestamp: r.created_at,
    mode: r.mode,
    selections: r.selections,
    stake: r.stake,
    totalOdds: r.total_odds,
    possibleWin: r.possible_win,
    status: r.status,
    settledAt: r.settled_at,
  };
}

// ══════════════════════════════════════════
// INTEGRITY & BET BUILDER
// ══════════════════════════════════════════
async function logIntegrityEvent({ userId, fixtureId, rule, detail }) {
  await pool.query(
    "INSERT INTO integrity_events (user_id, fixture_id, rule, detail) VALUES ($1, $2, $3, $4)",
    [userId, fixtureId ?? null, rule, JSON.stringify(detail || {})]
  );
}

async function getRecentIntegrityEvents(limit = 50) {
  const { rows } = await pool.query(
    "SELECT user_id, fixture_id, rule, detail, created_at FROM integrity_events ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return rows.map(r => ({ userId: r.user_id, fixtureId: r.fixture_id, rule: r.rule, detail: r.detail, createdAt: r.created_at }));
}

/** The latest scoring run's results, most suspicious first. */
async function getLatestIntegrityFlags() {
  const { rows } = await pool.query(
    `SELECT run_id, user_id, score, flagged, reasons, features, created_at FROM integrity_flags
     WHERE run_id = (SELECT run_id FROM integrity_flags ORDER BY created_at DESC LIMIT 1)
     ORDER BY score DESC`
  );
  return rows.map(r => ({ runId: r.run_id, userId: r.user_id, score: r.score, flagged: r.flagged, reasons: r.reasons, features: r.features, createdAt: r.created_at }));
}

async function logBetBuilderUsage({ userId, model, inputTokens, outputTokens, costUsd, latencyMs, outcome }) {
  await pool.query(
    `INSERT INTO bet_builder_usage (user_id, model, input_tokens, output_tokens, cost_usd, latency_ms, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, model, inputTokens, outputTokens, costUsd, latencyMs, outcome || null]
  );
}

/** How many bet-builder model calls a user made in the last 24 hours (for the daily limit). */
async function betBuilderCallsLastDay(userId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM bet_builder_usage WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'",
    [userId]
  );
  return rows[0].n;
}

// ── Exports ──
module.exports = {
  logIntegrityEvent,
  getRecentIntegrityEvents,
  getLatestIntegrityFlags,
  logBetBuilderUsage,
  betBuilderCallsLastDay,
  pool,
  initDB,
  getUsers,
  getUserById,
  createUser,
  updateUserPassword,
  deleteUser,
  updateUserCredits,
  getBetsByUser,
  getPendingBets,
  createBet,
  settleBet,
  placeBetTransaction,
  settleBetTransaction,
  loadMatches,
  saveMatches,
  replaceAllMatches,
};
