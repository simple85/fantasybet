const integrity = require("../integrity");
const { countRedCards } = require("../fetch-data");

beforeEach(() => integrity.__reset());

describe("noteLiveUpdate", () => {
  test("the first sighting of a match is not an incident", () => {
    expect(integrity.noteLiveUpdate(1, { score: { home: 2, away: 1 } })).toBeNull();
  });

  test("a changed score is a goal", () => {
    integrity.noteLiveUpdate(1, { score: { home: 0, away: 0 } }, 1000);
    expect(integrity.noteLiveUpdate(1, { score: { home: 0, away: 1 }, elapsed: 33 }, 2000)).toEqual({
      at: 2000, kind: "goal", minute: 33, score: { home: 0, away: 1 },
    });
  });

  test("a disallowed goal (score goes back down) also pauses the market", () => {
    integrity.noteLiveUpdate(1, { score: { home: 1, away: 0 } }, 1000);
    expect(integrity.noteLiveUpdate(1, { score: { home: 0, away: 0 } }, 2000)?.kind).toBe("goal");
  });

  test("a new red card is an incident", () => {
    integrity.noteLiveUpdate(1, { score: { home: 0, away: 0 }, redCards: { home: 0, away: 0 } }, 1000);
    expect(integrity.noteLiveUpdate(1, { score: { home: 0, away: 0 }, redCards: { home: 1, away: 0 } }, 2000)?.kind).toBe("red_card");
  });

  test("an unchanged update is not an incident", () => {
    integrity.noteLiveUpdate(1, { score: { home: 0, away: 0 } }, 1000);
    expect(integrity.noteLiveUpdate(1, { score: { home: 0, away: 0 } }, 2000)).toBeNull();
  });
});

describe("checkLiveBet", () => {
  const match = { elapsed: 70, score: { home: 0, away: 0 } };

  test("refuses everything before the odds feed has ever ticked", () => {
    expect(integrity.checkLiveBet(1, match, 10_000)).toMatchObject({ ok: false, rule: "feed_delayed" });
  });

  test("allows a quiet match with a fresh feed", () => {
    integrity.noteOddsTick(10_000);
    integrity.noteOddsChanged(1, 8_000);
    expect(integrity.checkLiveBet(1, match, 12_000)).toEqual({
      ok: true,
      snapshot: { minute: 70, score: { home: 0, away: 0 }, feedAgeMs: 2_000, oddsAgeMs: 4_000, msSinceIncident: null, lastIncident: null },
    });
  });

  test("forgetFixture clears a finished match's incidents", () => {
    integrity.noteOddsTick(100_000);
    integrity.noteLiveUpdate(1, { score: { home: 0, away: 0 } }, 1_000);
    integrity.noteLiveUpdate(1, { score: { home: 1, away: 0 } }, 99_000);
    integrity.forgetFixture(1);
    expect(integrity.checkLiveBet(1, match, 100_000).ok).toBe(true);
  });
});

test("countRedCards counts reds and second yellows per team", () => {
  const item = {
    teams: { home: { id: 10 }, away: { id: 20 } },
    events: [
      { type: "Card", detail: "Yellow Card", team: { id: 10 } },
      { type: "Card", detail: "Red Card", team: { id: 20 } },
      { type: "Card", detail: "Second Yellow card", team: { id: 10 } },
      { type: "Goal", detail: "Normal Goal", team: { id: 10 } },
    ],
  };
  expect(countRedCards(item)).toEqual({ home: 1, away: 1 });
});
