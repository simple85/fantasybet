const quota = require("../quota");

const T0 = Date.parse("2026-11-07T00:00:00Z");
const H = 3600e3, MIN = 60e3;
const match = (id, kickoffMs, extra = {}) => ({
  id, date: new Date(kickoffMs).toISOString(), status: "Not Started", statusShort: "NS", league: { id: 39 }, ...extra,
});

describe("modeFor", () => {
  test("small plans run the budget engine, large ones the full engine", () => {
    expect(quota.modeFor(100)).toBe("budget");
    expect(quota.modeFor(7500)).toBe("budget");
    expect(quota.modeFor(75000)).toBe("full");
  });
});

describe("parseLeagues", () => {
  test("reads ids and falls back to the defaults", () => {
    expect([...quota.parseLeagues("203, 39,x")]).toEqual([203, 39]);
    expect([...quota.parseLeagues("")]).toEqual(quota.DEFAULT_LEAGUES);
  });
});

describe("createBudget", () => {
  let now;
  const budget = () => quota.createBudget({ dailyLimit: 10, reserve: 2, now: () => now });
  beforeEach(() => { now = T0 + 10 * H; });

  test("planned work stays out of the reserve; urgent work may use it", () => {
    const b = budget();
    for (let i = 0; i < 8; i++) expect(b.tryConsume(1, "live")).toBe(true);
    expect(b.tryConsume(1, "live")).toBe(false);
    expect(b.tryConsume(1, "settlement", { urgent: true })).toBe(true);
    expect(b.tryConsume(2, "settlement", { urgent: true })).toBe(false);
    expect(b.spentByPurpose()).toEqual({ live: 8, settlement: 1 });
  });

  test("the API's headers override the local count", () => {
    const b = budget();
    b.tryConsume(1, "live");
    b.sync({ remaining: 4, limit: 10 });  // e.g. after a restart, or another client using the key
    expect(b.used()).toBe(6);
    b.sync({ remaining: 7000, limit: 7500 });  // the plan turns out to be bigger
    expect(b.limit).toBe(7500);
    expect(b.spendable()).toBe(7000 - 2);
  });

  test("resets at 00:00 UTC", () => {
    const b = budget();
    b.tryConsume(5, "live");
    now = T0 + 24 * H + 1;
    expect(b.used()).toBe(0);
    expect(b.spentByPurpose()).toEqual({});
  });
});

describe("watchList", () => {
  test("watches from just before kickoff until the match can be over", () => {
    const m = match(1, T0 + 15 * H);
    expect(quota.watchList([m], T0 + 15 * H - 5 * MIN)).toEqual([]);
    expect(quota.watchList([m], T0 + 15 * H - 1 * MIN)).toEqual([m]);
    expect(quota.watchList([m], T0 + 15 * H + 130 * MIN)).toEqual([m]);
    expect(quota.watchList([m], T0 + 15 * H + 140 * MIN)).toEqual([]);
  });

  test("keeps watching a match still live after the usual window (extra time), and stops when it is over", () => {
    const m = match(1, T0 + 15 * H, { statusShort: "ET" });
    expect(quota.watchList([m], T0 + 15 * H + 150 * MIN)).toEqual([m]);
    expect(quota.watchList([{ ...m, statusShort: "FT" }], T0 + 15 * H + 60 * MIN)).toEqual([]);
  });
});

describe("watchCallMs", () => {
  const W = 137 * MIN; // window incl. the 2 minutes before kickoff

  test("overlapping matches share a poll (one ?ids= call)", () => {
    const ms = quota.watchCallMs([match(1, T0 + 15 * H), match(2, T0 + 15 * H)], T0);
    expect(ms).toBe(W);
  });

  test("more than 20 matches at once need a second call", () => {
    const many = Array.from({ length: 25 }, (_, i) => match(i, T0 + 15 * H));
    expect(quota.watchCallMs(many, T0)).toBe(2 * W);
  });

  test("only counts what is left of today", () => {
    expect(quota.watchCallMs([match(1, T0 + 23 * H)], T0)).toBe(1 * H + 2 * MIN);
    expect(quota.watchCallMs([match(1, T0 + 15 * H)], T0 + 15 * H + 37 * MIN)).toBe(98 * MIN);
  });
});

describe("liveIntervalMs", () => {
  test("spreads the budget over the watching time that is left", () => {
    // 3 separate matches → 3 × 137 min of watching; 41.1 requests → one poll every 10 min
    const ms = [match(1, T0 + 12 * H), match(2, T0 + 15 * H), match(3, T0 + 19 * H)];
    expect(quota.liveIntervalMs({ matches: ms, now: T0, budget: 41.1 })).toBe(10 * MIN);
  });

  test("is clamped, and null when nothing is left", () => {
    const ms = [match(1, T0 + 12 * H)];
    expect(quota.liveIntervalMs({ matches: ms, now: T0, budget: 100000 })).toBe(quota.MIN_LIVE_INTERVAL_MS);
    expect(quota.liveIntervalMs({ matches: ms, now: T0, budget: 1 })).toBe(quota.MAX_LIVE_INTERVAL_MS);
    expect(quota.liveIntervalMs({ matches: ms, now: T0, budget: 0 })).toBeNull();
    expect(quota.liveIntervalMs({ matches: [], now: T0, budget: 50 })).toBeNull();
  });
});

describe("preMatchPlan", () => {
  const ms = [match(3, T0 + 20 * H), match(1, T0 + 12 * H), match(2, T0 + 14 * H), match(4, T0 + 50 * H),
    match(5, T0 + 13 * H, { statusShort: "PST" })];
  const plan = (opts) => quota.preMatchPlan({ matches: ms, now: T0, fetchedAt: new Map(), budget: 90, limit: 100, spentToday: 0, ...opts });
  const ids = (p) => p.units.flatMap((u) => u.ids);

  test("soonest kickoff first, within the horizon, upcoming only", () => {
    expect(plan().units.map((u) => u.kind)).toEqual(["fixture", "fixture", "fixture"]);  // no season known
    expect(ids(plan())).toEqual([1, 2, 3]);
  });

  test("skips matches fetched recently and respects the pre-match share", () => {
    expect(ids(plan({ fetchedAt: new Map([[1, T0 - 2 * H]]) }))).toEqual([2, 3]);
    expect(ids(plan({ spentToday: 49 }))).toEqual([1]);
    expect(ids(plan({ budget: 1 }))).toEqual([1]);
  });

  test("a league with several due matches is fetched whole (10 odds per request)", () => {
    const league = { id: 39, season: 2026 };
    const many = [1, 2, 3, 4].map((i) => match(i, T0 + (10 + i) * H, { league }));
    const lone = match(9, T0 + 9 * H, { league: { id: 140, season: 2026 } });
    const p = quota.preMatchPlan({ matches: [...many, lone], now: T0, fetchedAt: new Map(), budget: 90, limit: 100, spentToday: 0 });
    expect(p.units).toEqual([
      { kind: "fixture", ids: [9], first: T0 + 9 * H },
      { kind: "league", league: 39, season: 2026, ids: [1, 2, 3, 4], first: T0 + 11 * H },
    ]);
    // when the league's estimate no longer fits, its matches go one by one
    const tight = quota.preMatchPlan({ matches: many, now: T0, fetchedAt: new Map(), budget: 2, limit: 100, spentToday: 0 });
    expect(tight.units).toEqual([{ kind: "fixture", ids: [1], first: T0 + 11 * H }, { kind: "fixture", ids: [2], first: T0 + 11 * H }]);
  });

  test("preMatchStillNeeded counts what will enter the horizon before the reset", () => {
    expect(quota.preMatchStillNeeded({ matches: ms, now: T0, fetchedAt: new Map(), limit: 100, spentToday: 0 })).toBe(3);  // 4 in one league → ~3 requests
    expect(quota.preMatchStillNeeded({ matches: ms, now: T0, fetchedAt: new Map(), limit: 100, spentToday: 48 })).toBe(2);
  });
});

describe("purposeOf", () => {
  test("labels requests by what they are for", () => {
    expect(quota.purposeOf("status")).toBe("status");
    expect(quota.purposeOf("odds/live")).toBe("liveOdds");
    expect(quota.purposeOf("odds", { fixture: 1 })).toBe("preMatch");
    expect(quota.purposeOf("fixtures", { ids: "1-2" })).toBe("live");
    expect(quota.purposeOf("fixtures", { date: "2026-11-07" })).toBe("fixtures");
    expect(quota.purposeOf("fixtures/statistics", { fixture: 1 })).toBe("settlement");
  });
});
