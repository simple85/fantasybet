// ============================================
// FANTASYBET AUTH — password hashing + signed session cookies
// ============================================
// Passwords:  scrypt with a random salt, stored as "scrypt$<salt>$<hash>".
//             Old plaintext passwords still work once and are re-hashed on login.
// Sessions:   HMAC-signed cookie with user id, role and expiry. The server
//             never trusts a user id sent by the browser.

const crypto = require("crypto");

const COOKIE = "fb_session";
const SESSION_DAYS = 7;
const KEY_LENGTH = 64;

let warnedAboutSecret = false;
const devSecret = crypto.randomBytes(32).toString("hex");

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production");
  }
  if (!warnedAboutSecret) {
    console.warn("[AUTH] SESSION_SECRET not set — using a random key; sessions reset on restart");
    warnedAboutSecret = true;
  }
  return devSecret;
}

// ── Passwords ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}

/** Checks a password against a stored value (hashed, or legacy plaintext). */
function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string" || !stored) return false;
  if (!isHashed(stored)) return safeEqual(password, stored);
  const [, salt, hash] = stored.split("$");
  const candidate = crypto.scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return safeEqual(candidate, hash);
}

// ── Sessions ──
function sign(payload) {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function createSessionToken(userId, role, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, role, exp: now + SESSION_DAYS * 86400000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSessionToken(token, now = Date.now()) {
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.sub !== "string" || typeof data.exp !== "number" || data.exp < now) return null;
    return { userId: data.sub, role: data.role === "admin" ? "admin" : "user" };
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, userId, role) {
  res.cookie(COOKIE, createSessionToken(userId, role), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 86400000,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: "/" });
}

// ── Express middleware ──
function attachSession(req, res, next) {
  req.session = readSessionToken(readCookie(req, COOKIE));
  next();
}

function requireUser(req, res, next) {
  if (!req.session) return res.status(401).json({ success: false, error: "Not logged in" });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session) return res.status(401).json({ success: false, error: "Not logged in" });
  if (req.session.role !== "admin") return res.status(403).json({ success: false, error: "Admins only" });
  next();
}

/** Users may only access their own data (route param `param`); admins may access anyone's. */
function requireSelfOrAdmin(param) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ success: false, error: "Not logged in" });
    const target = String(req.params[param] || "").toLowerCase();
    if (req.session.role !== "admin" && req.session.userId !== target) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    next();
  };
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  isHashed,
  safeEqual,
  createSessionToken,
  readSessionToken,
  setSessionCookie,
  clearSessionCookie,
  attachSession,
  requireUser,
  requireAdmin,
  requireSelfOrAdmin,
};
