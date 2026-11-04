jest.mock("../db");

const request = require("supertest");
const db = require("../db");
const auth = require("../auth");
const { app, settleBets, __setState } = require("../server");
const integrity = require("../integrity");

const user = { id: "ali", password: auth.hashPassword("ali123"), displayName: "Ali Yilmaz", credits: 100 };

// Supertest agents keep cookies, so each one behaves like a separate browser.
async function loginAs(id, password, stored = user) {
  const agent = request.agent(app);
  db.getUserById.mockResolvedValueOnce(stored);
  const res = await agent.post("/api/auth/login").send({ id, password });
  expect(res.body.success).toBe(true);
  return agent;
}
const asAdmin = async () => {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ id: "admin", password: "admin-secret" }).expect(200);
  return agent;
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env.ADMIN_ID = "admin";
  process.env.ADMIN_PASSWORD = "admin-secret";
  process.env.SESSION_SECRET = "test-session-secret";
  __setState({ matches: [], currentLiveOdds: [] });
});

describe("POST /api/auth/login", () => {
  test("logs in a user with valid credentials (case-insensitive id)", async () => {
    db.getUserById.mockResolvedValue(user);

    const res = await request(app).post("/api/auth/login").send({ id: "ALI", password: "ali123" });

    expect(db.getUserById).toHaveBeenCalledWith("ali");
    expect(res.body).toEqual({ success: true, user: { id: "ali", displayName: "Ali Yilmaz", credits: 100 } });
  });

  test("sets an httpOnly session cookie", async () => {
    db.getUserById.mockResolvedValue(user);

    const res = await request(app).post("/api/auth/login").send({ id: "ali", password: "ali123" });

    expect(res.headers["set-cookie"][0]).toMatch(/^fb_session=.+; .*HttpOnly/);
    expect(res.headers["set-cookie"][0]).toMatch(/SameSite=Lax/);
  });

  test("upgrades a legacy plaintext password to a hash", async () => {
    db.getUserById.mockResolvedValue({ ...user, password: "ali123" });

    const res = await request(app).post("/api/auth/login").send({ id: "ali", password: "ali123" });

    expect(res.body.success).toBe(true);
    expect(db.updateUserPassword).toHaveBeenCalledWith("ali", expect.stringMatching(/^scrypt\$/));
  });

  test("does not re-hash an already hashed password", async () => {
    db.getUserById.mockResolvedValue(user);

    await request(app).post("/api/auth/login").send({ id: "ali", password: "ali123" });

    expect(db.updateUserPassword).not.toHaveBeenCalled();
  });

  test("admin login is disabled when ADMIN_PASSWORD is not set", async () => {
    process.env.ADMIN_PASSWORD = "";
    db.getUserById.mockResolvedValue(null);

    const res = await request(app).post("/api/auth/login").send({ id: "admin", password: "anything" });

    expect(res.body.success).toBe(false);
  });

  test("logout clears the session", async () => {
    const agent = await loginAs("ali", "ali123");
    await agent.get("/api/auth/me").expect(200);

    await agent.post("/api/auth/logout").expect(200);

    await agent.get("/api/auth/me").expect(401);
  });

  test("never returns the password", async () => {
    db.getUserById.mockResolvedValue(user);

    const res = await request(app).post("/api/auth/login").send({ id: "ali", password: "ali123" });

    expect(JSON.stringify(res.body)).not.toContain("ali123");
  });

  test("rejects a wrong password", async () => {
    db.getUserById.mockResolvedValue(user);

    const res = await request(app).post("/api/auth/login").send({ id: "ali", password: "nope" });

    expect(res.body).toEqual({ success: false, error: "Invalid credentials" });
  });

  test("rejects missing fields without touching the database", async () => {
    const res = await request(app).post("/api/auth/login").send({ id: "ali" });

    expect(res.body.success).toBe(false);
    expect(db.getUserById).not.toHaveBeenCalled();
  });

  test("admin credentials come from the environment", async () => {
    const res = await request(app).post("/api/auth/login").send({ id: "admin", password: "admin-secret" });

    expect(res.body.user).toMatchObject({ id: "admin", isAdmin: true });
  });

  test("returns 500 when the database fails", async () => {
    db.getUserById.mockRejectedValue(new Error("connection refused"));

    const res = await request(app).post("/api/auth/login").send({ id: "ali", password: "ali123" });

    expect(res.status).toBe(500);
  });
});

describe("admin-only endpoints", () => {
  const endpoints = [
    ["get", "/api/users"],
    ["post", "/api/users"],
    ["delete", "/api/users/ali"],
    ["post", "/api/users/ali/credits"],
    ["post", "/api/fetch/daily"],
    ["post", "/api/fetch/prematch"],
    ["post", "/api/settle"],
  ];

  test.each(endpoints)("%s %s rejects anonymous visitors with 401", async (method, url) => {
    const res = await request(app)[method](url).send({ action: "add", amount: 1_000_000 });

    expect(res.status).toBe(401);
    expect(db.updateUserCredits).not.toHaveBeenCalled();
    expect(db.createUser).not.toHaveBeenCalled();
    expect(db.deleteUser).not.toHaveBeenCalled();
  });

  test.each(endpoints)("%s %s rejects regular users with 403", async (method, url) => {
    const agent = await loginAs("ali", "ali123");

    const res = await agent[method](url).send({ action: "add", amount: 1_000_000 });

    expect(res.status).toBe(403);
    expect(db.updateUserCredits).not.toHaveBeenCalled();
  });

  test("a forged session cookie is ignored", async () => {
    const forged = Buffer.from(JSON.stringify({ sub: "admin", role: "admin", exp: Date.now() + 1e9 })).toString("base64url");

    const res = await request(app).get("/api/users").set("Cookie", `fb_session=${forged}.fakesignature`);

    expect(res.status).toBe(401);
  });

  test("admin can list users without seeing passwords", async () => {
    db.getUsers.mockResolvedValue([user]);
    const admin = await asAdmin();

    const res = await admin.get("/api/users");

    expect(res.body).toEqual([{ id: "ali", displayName: "Ali Yilmaz", credits: 100 }]);
  });
});

describe("user data is private", () => {
  test("users can read their own profile and bets", async () => {
    const agent = await loginAs("ali", "ali123");
    db.getUserById.mockResolvedValue(user);
    db.getBetsByUser.mockResolvedValue([]);

    await agent.get("/api/users/ali").expect(200);
    await agent.get("/api/bets/ali").expect(200);
  });

  test("users cannot read someone else's profile or bets", async () => {
    const agent = await loginAs("ali", "ali123");

    await agent.get("/api/users/max").expect(403);
    await agent.get("/api/bets/max").expect(403);
    expect(db.getBetsByUser).not.toHaveBeenCalled();
  });

  test("anonymous visitors cannot read any profile", async () => {
    await request(app).get("/api/users/ali").expect(401);
    await request(app).get("/api/bets/ali").expect(401);
  });
});

describe("POST /api/users/:id/credits", () => {
  let admin;
  beforeEach(async () => {
    admin = await asAdmin();
    db.getUserById.mockResolvedValue({ ...user });
  });

  test.each([
    ["add", 50, 150],
    ["subtract", 30, 70],
    ["subtract", 500, 0],
    ["set", 25, 25],
  ])("%s %d → %d", async (action, amount, expected) => {
    const res = await admin.post("/api/users/ali/credits").send({ action, amount });

    expect(res.body).toEqual({ success: true, credits: expected });
    expect(db.updateUserCredits).toHaveBeenCalledWith("ali", expected);
  });

  test("rejects negative amounts", async () => {
    const res = await admin.post("/api/users/ali/credits").send({ action: "add", amount: -5 });

    expect(res.status).toBe(400);
    expect(db.updateUserCredits).not.toHaveBeenCalled();
  });

  test("rejects unknown actions", async () => {
    const res = await admin.post("/api/users/ali/credits").send({ action: "double", amount: 5 });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/users", () => {
  test("creates a user with normalized id and a hashed password", async () => {
    const admin = await asAdmin();
    db.getUserById.mockResolvedValue(null);

    const res = await admin.post("/api/users").send({ id: "  Lena ", password: "pw", displayName: " Lena Weber " });

    expect(db.createUser).toHaveBeenCalledWith("lena", expect.stringMatching(/^scrypt\$/), "Lena Weber");
    expect(auth.verifyPassword("pw", db.createUser.mock.calls[0][1])).toBe(true);
    expect(res.body.user).toEqual({ id: "lena", displayName: "Lena Weber", credits: 0 });
  });

  test("returns 409 for an existing id", async () => {
    const admin = await asAdmin();
    db.getUserById.mockResolvedValue(user);

    const res = await admin.post("/api/users").send({ id: "ali", password: "x", displayName: "Ali" });

    expect(res.status).toBe(409);
  });
});

// A pre-match fixture with bookmaker odds, as the daily refresh stores it
const prematch = (id, odd = "2.00") => ({
  id,
  status: "Not Started",
  statusShort: "NS",
  home: { name: "Home FC" },
  away: { name: "Away FC" },
  bets: [{ id: 1, name: "Match Winner", values: [{ value: "Home", odd }, { value: "Draw", odd: "3.40" }, { value: "Away", odd: "3.80" }] }],
});

describe("POST /api/bets", () => {
  const selection = { matchId: 1, betId: 1, pick: "Home", odd: 2 };
  const body = { selections: [selection], stake: 10, totalOdds: 2, possibleWin: 20 };
  let agent;
  beforeEach(async () => {
    __setState({ matches: [prematch(1), prematch(2)] });
    agent = await loginAs("ali", "ali123");
  });

  test("requires a login", async () => {
    await request(app).post("/api/bets").send(body).expect(401);
    expect(db.placeBetTransaction).not.toHaveBeenCalled();
  });

  test("always bets for the logged-in user, ignoring a userId in the body", async () => {
    db.placeBetTransaction.mockResolvedValue({ credits: 90 });

    await agent.post("/api/bets").send({ ...body, userId: "max" }).expect(200);

    expect(db.placeBetTransaction).toHaveBeenCalledWith("ali", 10, expect.objectContaining({ userId: "ali" }));
  });

  test("recomputes the payout on the server", async () => {
    db.placeBetTransaction.mockResolvedValue({ credits: 90 });

    await agent.post("/api/bets").send({ ...body, totalOdds: 500, possibleWin: 1_000_000 }).expect(200);

    expect(db.placeBetTransaction).toHaveBeenCalledWith("ali", 10, expect.objectContaining({ totalOdds: 2, possibleWin: 20 }));
  });

  test.each([[-10], [0], ["abc"], [Infinity]])("rejects stake %p", async (stake) => {
    const res = await agent.post("/api/bets").send({ ...body, stake });

    expect(res.status).toBe(400);
    expect(db.placeBetTransaction).not.toHaveBeenCalled();
  });

  test.each([[0.5], [-2], ["x"]])("does not accept made-up odds %p", async (odd) => {
    const res = await agent.post("/api/bets").send({ ...body, selections: [{ ...selection, odd }] });

    expect(res.status).toBe(409);
    expect(db.placeBetTransaction).not.toHaveBeenCalled();
  });

  test("admins cannot place bets", async () => {
    const admin = await asAdmin();

    await admin.post("/api/bets").send(body).expect(403);
  });

  test("places a bet and returns remaining credits", async () => {
    db.placeBetTransaction.mockResolvedValue({ credits: 90 });

    const res = await agent.post("/api/bets").send(body);

    expect(res.body).toMatchObject({ success: true, bet: { status: "pending" }, credits: 90 });
    expect(db.placeBetTransaction).toHaveBeenCalledWith("ali", 10, expect.objectContaining({ stake: 10, mode: "combined" }));
  });

  test("system bets cost stake × selections", async () => {
    db.placeBetTransaction.mockResolvedValue({ credits: 80 });

    await agent.post("/api/bets").send({ ...body, mode: "system", selections: [selection, { ...selection, matchId: 2 }] });

    expect(db.placeBetTransaction).toHaveBeenCalledWith("ali", 20, expect.objectContaining({ mode: "system" }));
  });

  test("surfaces insufficient credits from the transaction", async () => {
    db.placeBetTransaction.mockResolvedValue({ error: "Insufficient credits" });

    const res = await agent.post("/api/bets").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Insufficient credits");
  });

  test("rejects bets on finished matches", async () => {
    __setState({ matches: [{ id: 1, statusShort: "FT", status: "Match Finished", home: { name: "A" }, away: { name: "B" } }] });

    const res = await agent.post("/api/bets").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already finished/);
    expect(db.placeBetTransaction).not.toHaveBeenCalled();
  });

  test("rejects suspended live odds", async () => {
    __setState({
      matches: [{ ...prematch(1), statusShort: "2H", status: "Second Half" }],
      currentLiveOdds: [{ fixtureId: 1, odds: [{ id: 1, values: [{ value: "Home", suspended: true }] }] }],
    });

    const res = await agent.post("/api/bets").send(body);

    expect(res.body.error).toBe("Odds suspended for this selection");
  });

  test("rejects incomplete requests", async () => {
    const res = await agent.post("/api/bets").send({});

    expect(res.status).toBe(400);
  });
});

describe("POST /api/bets — server-side pricing", () => {
  let agent;
  beforeEach(async () => {
    __setState({ matches: [prematch(1, "2.10")] });
    agent = await loginAs("ali", "ali123");
  });

  test("refuses a bet on the old price and returns the current odds", async () => {
    const res = await agent.post("/api/bets").send({ selections: [{ matchId: 1, betId: 1, pick: "Home", odd: 2 }], stake: 10, mode: "combined" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Odds changed", changes: [{ matchId: 1, betId: 1, pick: "Home", odd: 2.1 }] });
    expect(db.placeBetTransaction).not.toHaveBeenCalled();
  });

  test("stores only server-side data in the bet, not what the browser sent", async () => {
    db.placeBetTransaction.mockResolvedValue({ credits: 90 });

    await agent.post("/api/bets").send({
      selections: [{ matchId: 1, betId: 1, pick: "Home", odd: 2.1, marketLabel: "Fake market", result: "won", matchLabel: "<script>" }],
      stake: 10,
      mode: "combined",
    }).expect(200);

    const bet = db.placeBetTransaction.mock.calls[0][2];
    expect(bet.selections).toEqual([{ matchId: 1, matchLabel: "Home FC - Away FC", betId: 1, marketLabel: "Match Winner", pick: "Home", pickLabel: "Home", odd: 2.1 }]);
    expect(bet.possibleWin).toBe(21);
  });

  test.each([
    ["an unknown match", { matchId: 99, betId: 1, pick: "Home", odd: 2.1 }, "Unknown match"],
    ["an unknown market", { matchId: 1, betId: 77, pick: "Home", odd: 2.1 }, "Selection no longer available"],
    ["an unknown pick", { matchId: 1, betId: 1, pick: "Banana", odd: 2.1 }, "Selection no longer available"],
  ])("rejects %s", async (_, sel, error) => {
    const res = await agent.post("/api/bets").send({ selections: [sel], stake: 10, mode: "combined" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });
});

describe("POST /api/bets — pre-match betting closes at kickoff", () => {
  test("refuses pre-match odds once the kickoff time has passed, even if the status still says Not Started", async () => {
    // on a small API plan the status can lag the real kickoff by minutes
    __setState({ matches: [{ ...prematch(1), date: new Date(Date.now() - 60_000).toISOString() }] });
    const agent = await loginAs("ali", "ali123");
    db.getUserById.mockResolvedValue(user);
    const res = await agent.post("/api/bets").send({ selections: [{ matchId: 1, betId: 1, pick: "Home", odd: 2 }], stake: 10, mode: "combined" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Betting closed/);
  });
});

describe("POST /api/bets — live integrity guard", () => {
  const liveMatch = { ...prematch(5), status: "Second Half", statusShort: "2H", elapsed: 62, score: { home: 1, away: 0 } };
  const liveOdds = (odd = "1.40") => [{ fixtureId: 5, odds: [{ id: 59, name: "Fulltime Result", values: [{ value: "Home", odd, suspended: false }] }] }];
  const liveBet = (odd = 1.4) => ({ selections: [{ matchId: 5, betId: 59, pick: "Home", odd }], stake: 10, mode: "combined" });
  let agent;
  let now;
  beforeEach(async () => {
    integrity.__reset();
    now = Date.now();
    __setState({ matches: [liveMatch], currentLiveOdds: liveOdds() });
    agent = await loginAs("ali", "ali123");
  });

  test("never prices a live match from the pre-match odds", async () => {
    __setState({ currentLiveOdds: [] });
    integrity.noteOddsTick(now);

    const res = await agent.post("/api/bets").send({ selections: [{ matchId: 5, betId: 1, pick: "Home", odd: 2 }], stake: 10, mode: "combined" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Live odds not available for this match");
  });

  test("refuses live bets while the odds feed is delayed, and logs the attempt", async () => {
    integrity.noteOddsTick(now - integrity.FEED_MAX_AGE_MS - 1000);

    const res = await agent.post("/api/bets").send(liveBet());

    expect(res.status).toBe(400);
    expect(res.body.rule).toBe("feed_delayed");
    expect(db.logIntegrityEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: "ali", fixtureId: 5, rule: "feed_delayed" }));
  });

  test("closes the market right after a goal", async () => {
    integrity.noteOddsTick(now);
    integrity.noteOddsChanged(5, now - 60_000);
    integrity.noteLiveUpdate(5, { score: { home: 0, away: 0 }, elapsed: 60 }, now - 20_000);
    integrity.noteLiveUpdate(5, { score: { home: 1, away: 0 }, elapsed: 61 }, now - 5_000);

    const res = await agent.post("/api/bets").send(liveBet());

    expect(res.body.rule).toBe("incident_cooldown");
    expect(db.placeBetTransaction).not.toHaveBeenCalled();
  });

  test("keeps it closed until the odds have moved since the goal", async () => {
    integrity.noteOddsTick(now);
    integrity.noteOddsChanged(5, now - 120_000);
    integrity.noteLiveUpdate(5, { score: { home: 0, away: 0 } }, now - 100_000);
    integrity.noteLiveUpdate(5, { score: { home: 1, away: 0 } }, now - 60_000);

    const res = await agent.post("/api/bets").send(liveBet());

    expect(res.body.rule).toBe("odds_not_updated");
  });

  test("accepts the bet once fresh odds arrived, with a timing snapshot", async () => {
    db.placeBetTransaction.mockResolvedValue({ credits: 90 });
    integrity.noteOddsTick(now);
    integrity.noteLiveUpdate(5, { score: { home: 0, away: 0 } }, now - 100_000);
    integrity.noteLiveUpdate(5, { score: { home: 1, away: 0 } }, now - 60_000);
    integrity.noteOddsChanged(5, now - 10_000);

    await agent.post("/api/bets").send(liveBet()).expect(200);

    const sel = db.placeBetTransaction.mock.calls[0][2].selections[0];
    expect(sel).toMatchObject({ live: true, odd: 1.4, marketLabel: "Fulltime Result" });
    expect(sel.context).toMatchObject({ minute: 62, score: { home: 1, away: 0 }, lastIncident: "goal" });
    expect(sel.context.msSinceIncident).toBeGreaterThanOrEqual(60_000);
    expect(sel.context.oddsAgeMs).toBeGreaterThanOrEqual(10_000);
  });
});

describe("GET /api/matches", () => {
  test("only returns matches with odds or currently live", async () => {
    __setState({
      matches: [
        { id: 1, statusShort: "NS", bets: [{ id: 1 }] },
        { id: 2, statusShort: "1H", bets: [] },
        { id: 3, statusShort: "NS", bets: [] },
      ],
    });

    const res = await request(app).get("/api/matches");

    expect(res.body.matchCount).toBe(3);
    expect(res.body.matches.map(m => m.id)).toEqual([1, 2]);
  });
});

describe("settleBets", () => {
  test("settles a finished combined bet and credits the payout", async () => {
    __setState({
      matches: [{
        id: 7, status: "Match Finished", statusShort: "FT",
        score: { home: 2, away: 0 }, htScore: { home: 1, away: 0 },
        events: { goals: [] }, stats: { home: {}, away: {} },
      }],
    });
    db.getPendingBets.mockResolvedValue([{
      id: "FB1", userId: "ali", mode: "combined", stake: 10, totalOdds: 1.8, possibleWin: 18,
      selections: [{ matchId: 7, betId: 1, pick: "Home", odd: 1.8 }],
    }]);
    db.settleBetTransaction.mockResolvedValue();

    const result = await settleBets();

    expect(result).toEqual({ settled: 1 });
    expect(db.settleBetTransaction).toHaveBeenCalledWith(
      "FB1", "won", 18, 1.8, [expect.objectContaining({ result: "won" })], "ali", 18);
  });

  test("leaves bets on unfinished matches pending", async () => {
    __setState({ matches: [{ id: 7, status: "First Half", statusShort: "1H", score: { home: 0, away: 0 } }] });
    db.getPendingBets.mockResolvedValue([{
      id: "FB2", userId: "ali", mode: "combined", stake: 10, totalOdds: 2, possibleWin: 20,
      selections: [{ matchId: 7, betId: 1, pick: "Home", odd: 2 }],
    }]);

    expect(await settleBets()).toEqual({ settled: 0 });
    expect(db.settleBetTransaction).not.toHaveBeenCalled();
  });

  test("voids bets on postponed matches and refunds the stake", async () => {
    __setState({ matches: [{ id: 7, status: "Match Postponed", statusShort: "PST", score: { home: null, away: null } }] });
    db.getPendingBets.mockResolvedValue([{
      id: "FB3", userId: "ali", mode: "combined", stake: 10, totalOdds: 2, possibleWin: 20,
      selections: [{ matchId: 7, betId: 1, pick: "Home", odd: 2 }],
    }]);
    db.settleBetTransaction.mockResolvedValue();

    await settleBets();

    expect(db.settleBetTransaction).toHaveBeenCalledWith("FB3", "void", 20, 2, expect.any(Array), "ali", 10);
  });
});

describe("GET /api/admin/integrity", () => {
  test("is for admins only", async () => {
    const agent = await loginAs("ali", "ali123");
    await agent.get("/api/admin/integrity").expect(403);
  });

  test("returns the latest flags and refused attempts", async () => {
    db.getLatestIntegrityFlags.mockResolvedValue([{ userId: "max", score: 0.97, flagged: true, reasons: { text: ["…"] } }]);
    db.getRecentIntegrityEvents.mockResolvedValue([{ userId: "max", rule: "incident_cooldown" }]);
    const admin = await asAdmin();

    const res = await admin.get("/api/admin/integrity").expect(200);

    expect(res.body.flags[0].userId).toBe("max");
    expect(res.body.refused[0].rule).toBe("incident_cooldown");
  });
});
