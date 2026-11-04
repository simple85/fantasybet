// Simulates a busy Saturday on the free API plan (100 requests a day, 10 a minute): a fake
// API-Football answers the real HTTP requests, a fake clock runs the budget engine through the
// whole day, and the test checks the quota held while odds and results still arrived.

process.env.API_FOOTBALL_KEY = "test-key-123";
delete process.env.API_FOOTBALL_DAILY_LIMIT;
delete process.env.API_FOOTBALL_LEAGUES;

jest.mock("https", () => ({ request: jest.fn() }));
jest.mock("../db");

const https = require("https");
const { EventEmitter } = require("events");
const db = require("../db");

const DAY = 24 * 3600e3, H = 3600e3, MIN = 60e3;
const SAT = Date.parse("2026-11-07T00:00:00Z");
const LIMIT = 100, PER_MINUTE = 10;

// ── The fixture list: 28 followed matches on Saturday, 20 on Sunday, plus leagues we don't follow ──
const fixtures = [];
let nextId = 1000;
const add = (dayStart, hhmm, league) => {
  const [h, m] = hhmm.split(":").map(Number);
  fixtures.push({ id: nextId++, kickoff: dayStart + h * H + m * MIN, league });
};
const SATURDAY = { "11:30": 2, "13:00": 3, "14:00": 6, "15:30": 4, "16:30": 3, "18:00": 4, "19:45": 4, "20:00": 2 };
let n = 0;
for (const [t, count] of Object.entries(SATURDAY)) for (let i = 0; i < count; i++) add(SAT, t, [39, 140, 78, 203][n++ % 4]);
for (let i = 0; i < 20; i++) add(SAT + DAY, ["12:00", "14:30", "17:00", "19:45"][i % 4], [39, 140, 78, 203][i % 4]);
for (let i = 0; i < 4; i++) add(SAT - DAY, "19:00", 39);
for (let d = -1; d <= 1; d++) for (let i = 0; i < 40; i++) add(SAT + d * DAY, "15:00", 999);

const FT_AFTER = 112 * MIN;  // kickoff → final whistle in this simulation
function state(f, t) {
  const into = t - f.kickoff;
  const goals = [];
  if (f.id % 2) goals.push({ minute: 20, side: "home" });
  if (f.id % 3 === 0) goals.push({ minute: 70, side: "away" });
  let short, long, elapsed;
  if (into < 0) [short, long, elapsed] = ["NS", "Not Started", null];
  else if (into < 46 * MIN) [short, long, elapsed] = ["1H", "First Half", Math.floor(into / MIN) + 1];
  else if (into < 62 * MIN) [short, long, elapsed] = ["HT", "Halftime", 45];
  else if (into < FT_AFTER) [short, long, elapsed] = ["2H", "Second Half", Math.min(90, 45 + Math.floor((into - 62 * MIN) / MIN))];
  else [short, long, elapsed] = ["FT", "Match Finished", 90];
  const scored = elapsed == null ? [] : goals.filter(g => g.minute <= elapsed);
  return {
    fixture: { id: f.id, date: new Date(f.kickoff).toISOString(), status: { short, long, elapsed } },
    league: { id: f.league, name: "L" + f.league, country: "X" },
    teams: { home: { id: f.id * 10, name: "Home " + f.id }, away: { id: f.id * 10 + 1, name: "Away " + f.id } },
    goals: elapsed == null ? { home: null, away: null } : { home: scored.filter(g => g.side === "home").length, away: scored.filter(g => g.side === "away").length },
    score: { halftime: { home: null, away: null } },
    events: scored.map(g => ({ type: "Goal", detail: "Normal Goal", time: { elapsed: g.minute }, team: { id: g.side === "home" ? f.id * 10 : f.id * 10 + 1, name: g.side }, player: { name: "P" } })),
    statistics: short === "FT" ? [
      { team: { id: f.id * 10, name: "H" }, statistics: [{ type: "Corner Kicks", value: 5 }, { type: "Yellow Cards", value: 2 }] },
      { team: { id: f.id * 10 + 1, name: "A" }, statistics: [{ type: "Corner Kicks", value: 3 }, { type: "Yellow Cards", value: 1 }] },
    ] : [],
  };
}

// ── The fake API: counts requests per UTC day and per minute like the real one ──
const log = [];        // { t, path }
const refused = [];    // requests the "API" refused
const oddsAt = new Map();
const ftSeenAt = new Map();
let used = 0, usedDay = null;
let forceError = null;

function answer(path, t) {
  if (forceError) return { errors: forceError, response: [] };
  const day = Math.floor(t / DAY);
  if (day !== usedDay) { usedDay = day; used = 0; }
  used++;
  log.push({ t, path });
  const lastMinute = log.filter(r => r.t > t - MIN).length;
  if (used > LIMIT) { refused.push({ t, path, why: "daily" }); return { errors: { requests: "You have reached the request limit for the day" }, response: [] }; }
  if (lastMinute > PER_MINUTE) { refused.push({ t, path, why: "minute" }); return { errors: { rateLimit: "Too many requests" }, response: [] }; }

  const url = new URL("https://x" + path);
  const p = Object.fromEntries(url.searchParams);
  if (url.pathname === "/fixtures" && p.date) {
    const start = Date.parse(p.date + "T00:00:00Z");
    return { errors: [], response: fixtures.filter(f => f.kickoff >= start && f.kickoff < start + DAY).map(f => state(f, t)) };
  }
  if (url.pathname === "/fixtures" && p.ids) {
    const ids = p.ids.split("-").map(Number);
    return { errors: [], response: fixtures.filter(f => ids.includes(f.id)).map(f => state(f, t)) };
  }
  if (url.pathname === "/odds") {
    oddsAt.set(Number(p.fixture), t);
    return { errors: [], response: [{ bookmakers: [{ id: 8, bets: [{ id: 1, name: "Match Winner", values: [{ value: "Home", odd: "2.10" }, { value: "Draw", odd: "3.30" }, { value: "Away", odd: "3.40" }] }] }] }] };
  }
  return { errors: [], response: [] };
}

https.request.mockImplementation((options, cb) => {
  const req = new EventEmitter();
  req.end = () => Promise.resolve().then(() => {
    const body = JSON.stringify(answer(options.path, Date.now()));
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = { "x-ratelimit-requests-limit": String(LIMIT), "x-ratelimit-requests-remaining": String(Math.max(0, LIMIT - used)) };
    cb(res);
    res.emit("data", Buffer.from(body));
    res.emit("end");
  });
  return req;
});

const { __engine: engine } = require("../server");

test("a busy Saturday on 100 requests: quota holds, odds arrive before kickoff, every result is seen", async () => {
  jest.useFakeTimers({ now: SAT + 30e3 });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  db.getPendingBets.mockResolvedValue([]);
  db.saveMatches.mockResolvedValue();
  db.replaceAllMatches.mockResolvedValue();

  engine.installQuotaHooks();
  const followedSat = fixtures.filter(f => f.league !== 999 && f.kickoff >= SAT && f.kickoff < SAT + DAY);
  const polls = [];

  // the engine's own 20 s tick, for the whole of Saturday and the first hour of Sunday
  while (Date.now() < SAT + DAY + H) {
    engine.budgetTick();
    await jest.advanceTimersByTimeAsync(20e3);
    for (const m of engine.matches()) {
      if (m.statusShort === "FT" && !ftSeenAt.has(m.id)) ftSeenAt.set(m.id, Date.now());
    }
  }
  jest.useRealTimers();
  console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore();

  const saturday = log.filter(r => r.t < SAT + DAY);
  const byKind = (re) => saturday.filter(r => re.test(r.path)).length;
  const finalDelay = followedSat.map(f => (ftSeenAt.get(f.id) ?? Infinity) - (f.kickoff + FT_AFTER));
  const livePolls = saturday.filter(r => /ids=/.test(r.path)).map(r => r.t);
  for (let i = 1; i < livePolls.length; i++) polls.push(livePolls[i] - livePolls[i - 1]);

  // 1. Never over the quota or the per-minute limit, and no live odds requests
  expect(refused).toEqual([]);
  expect(saturday.length).toBeLessThanOrEqual(LIMIT);
  expect(byKind(/odds\/live/)).toBe(0);

  // 2. Every followed Saturday match had odds before kickoff; unfollowed leagues cost nothing
  for (const f of followedSat) expect(oddsAt.get(f.id)).toBeLessThan(f.kickoff);
  expect(fixtures.filter(f => f.league === 999).some(f => oddsAt.has(f.id))).toBe(false);

  // 3. Every result arrived the same day, with the statistics settlement needs
  for (const f of followedSat) {
    const m = engine.matches().find(x => x.id === f.id);
    expect(m.statusShort).toBe("FT");
    expect(m.stats && m.stats.home.corners).toBe(5);
  }
  expect(Math.max(...finalDelay)).toBeLessThanOrEqual(30 * MIN);

  console.log([
    `Saturday: ${saturday.length}/${LIMIT} requests — fixtures ${byKind(/date=/)}, pre-match odds ${byKind(/\/odds\?/)}, live scores ${livePolls.length}`,
    `Live poll interval: median ${Math.round(polls.sort((a, b) => a - b)[Math.floor(polls.length / 2)] / MIN)} min`,
    `Final whistle seen after: median ${Math.round(finalDelay.sort((a, b) => a - b)[Math.floor(finalDelay.length / 2)] / MIN)} min, worst ${Math.round(Math.max(...finalDelay) / MIN)} min`,
  ].join("\n"));
}, 120e3);

test("an API error (like a used-up quota) is a failure, not an empty list of live matches", async () => {
  // Before: the error came back as response: [], so every live match looked finished and was settled
  const { fetchLiveFixtures, setQuotaHooks } = require("../fetch-data");
  setQuotaHooks({});  // no budget or request spacing for this one
  jest.spyOn(console, "error").mockImplementation(() => {});
  forceError = { requests: "You have reached the request limit for the day" };
  await expect(fetchLiveFixtures()).rejects.toThrow(/request limit/);
  forceError = null;
  console.error.mockRestore();
});
