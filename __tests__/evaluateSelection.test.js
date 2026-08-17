const { evaluateSelection } = require("../server");

const HOME = 10;
const AWAY = 20;

// Builds a finished match. `goals` is a list of [minute, "home" | "away", player?].
function match({ ft, ht = null, goals = null, stats = null }) {
  return {
    home: { id: HOME, name: "Home FC" },
    away: { id: AWAY, name: "Away United" },
    score: { home: ft[0], away: ft[1] },
    htScore: ht ? { home: ht[0], away: ht[1] } : null,
    events: goals && {
      goals: goals.map(([minute, side, player = "Player", detail = "Normal Goal"]) => ({
        minute, teamId: side === "home" ? HOME : AWAY, player, detail,
      })),
    },
    stats,
  };
}

const pre = (betId, pick) => ({ betId, pick });
const named = (marketLabel, pick) => ({ marketLabel, pick });

describe("ID-based markets (pre-match Bet365 IDs)", () => {
  test.each([
    ["Home", [2, 1], "won"],
    ["Home", [1, 1], "lost"],
    ["Draw", [0, 0], "won"],
    ["Away", [0, 3], "won"],
  ])("Match Winner %s at %j → %s", (pick, ft, expected) => {
    expect(evaluateSelection(pre(1, pick), match({ ft }))).toBe(expected);
  });

  test.each([
    ["Over 2.5", [2, 1], "won"],
    ["Over 2.5", [1, 1], "lost"],
    ["Under 2.5", [1, 1], "won"],
    ["Under 1.5", [1, 1], "lost"],
  ])("Goals Over/Under %s at %j → %s", (pick, ft, expected) => {
    expect(evaluateSelection(pre(5, pick), match({ ft }))).toBe(expected);
  });

  test.each([
    ["Yes", [1, 1], "won"],
    ["Yes", [2, 0], "lost"],
    ["No", [2, 0], "won"],
  ])("Both Teams Score %s at %j → %s", (pick, ft, expected) => {
    expect(evaluateSelection(pre(8, pick), match({ ft }))).toBe(expected);
  });

  test("Exact Score", () => {
    expect(evaluateSelection(pre(10, "2:1"), match({ ft: [2, 1] }))).toBe("won");
    expect(evaluateSelection(pre(10, "1:2"), match({ ft: [2, 1] }))).toBe("lost");
  });

  test.each([
    ["Home/Draw", [1, 1], "won"],
    ["Home/Away", [1, 1], "lost"],
    ["Draw/Away", [0, 2], "won"],
  ])("Double Chance %s at %j → %s", (pick, ft, expected) => {
    expect(evaluateSelection(pre(12, pick), match({ ft }))).toBe(expected);
  });

  test("Odd/Even uses total goals", () => {
    expect(evaluateSelection(pre(21, "Odd"), match({ ft: [2, 1] }))).toBe("won");
    expect(evaluateSelection(pre(21, "Even"), match({ ft: [2, 1] }))).toBe("lost");
  });

  test("team totals use only that team's goals", () => {
    expect(evaluateSelection(pre(17, "Over 1.5"), match({ ft: [2, 0] }))).toBe("won");
    expect(evaluateSelection(pre(18, "Over 0.5"), match({ ft: [2, 0] }))).toBe("lost");
  });

  describe("Asian Handicap (4)", () => {
    test.each([
      ["Home -1.5", [2, 0], "won"],
      ["Home -1.5", [1, 0], "lost"],
      ["Away +1.5", [1, 0], "won"],
      ["Home -1", [1, 0], "void"], // push refunds the stake
    ])("%s at %j → %s", (pick, ft, expected) => {
      expect(evaluateSelection(pre(4, pick), match({ ft }))).toBe(expected);
    });
  });

  describe("3-way Handicap (51)", () => {
    test("negative line handicaps the away side", () => {
      expect(evaluateSelection(pre(51, "Home -1"), match({ ft: [2, 0] }))).toBe("won");
    });
    test("positive line is added to the home side", () => {
      expect(evaluateSelection(pre(51, "Draw +1"), match({ ft: [0, 1] }))).toBe("won");
    });
  });

  describe("half-time markets", () => {
    test("stay pending while HT score is unknown", () => {
      expect(evaluateSelection(pre(13, "Home"), match({ ft: [1, 0] }))).toBeNull();
    });

    test("derive HT score from goal events when missing", () => {
      const m = match({ ft: [1, 1], goals: [[30, "home"], [80, "away"]] });
      expect(evaluateSelection(pre(13, "Home"), m)).toBe("won");
    });

    test("First Half Winner and HT/FT", () => {
      const m = match({ ft: [1, 2], ht: [1, 0] });
      expect(evaluateSelection(pre(13, "Home"), m)).toBe("won");
      expect(evaluateSelection(pre(7, "Home/Away"), m)).toBe("won");
      expect(evaluateSelection(pre(7, "Home/Home"), m)).toBe("lost");
    });

    test("second-half goals are FT minus HT", () => {
      const m = match({ ft: [3, 1], ht: [1, 1] });
      expect(evaluateSelection(pre(72, "Over 1.5"), m)).toBe("won"); // 2 goals after HT
      expect(evaluateSelection(pre(26, "Yes"), m)).toBe("lost"); // away didn't score in 2nd half
    });

    test("Win Both Halves", () => {
      expect(evaluateSelection(pre(3, "Home"), match({ ft: [3, 0], ht: [1, 0] }))).toBe("won");
      expect(evaluateSelection(pre(3, "Home"), match({ ft: [1, 0], ht: [1, 0] }))).toBe("lost");
    });
  });

  test("unknown market IDs are voided", () => {
    expect(evaluateSelection(pre(9999, "Whatever"), match({ ft: [1, 0], ht: [0, 0] }))).toBe("void");
  });
});

describe("name-based markets (live bets)", () => {
  test("market label takes priority over the bet ID", () => {
    // live feeds reuse IDs for different markets, so "Match Goals" wins over betId 1
    const sel = { betId: 1, marketLabel: "Match Goals", pick: "Over 2.5" };
    expect(evaluateSelection(sel, match({ ft: [2, 1] }))).toBe("won");
  });

  test.each([
    ["Fulltime Result", "Home", [2, 0], "won"],
    ["Match Goals", "Under 2.5", [2, 1], "lost"],
    ["Both Teams to Score", "Yes", [1, 1], "won"],
    ["Final Score", "2:2", [2, 2], "won"],
    ["Draw No Bet", "Home", [1, 1], "void"],
    ["Double Chance", "Home or Draw", [0, 0], "won"],
    ["Asian Handicap", "Away +0.5", [0, 0], "won"],
    ["How many goals will Away Team score?", "Over 0.5", [3, 0], "lost"],
  ])("%s / %s at %j → %s", (label, pick, ft, expected) => {
    expect(evaluateSelection(named(label, pick), match({ ft }))).toBe(expected);
  });

  test("1x2 at N minutes counts goals up to that minute", () => {
    const m = match({ ft: [1, 1], goals: [[5, "home"], [25, "away"]] });
    expect(evaluateSelection(named("1x2 - 10 min", "Home"), m)).toBe("won");
    expect(evaluateSelection(named("1x2 - 30 min", "Draw"), m)).toBe("won");
  });

  test("event-based markets wait for event data", () => {
    expect(evaluateSelection(named("1x2 - 10 min", "Home"), match({ ft: [1, 0] }))).toBeNull();
  });

  describe("goal scorer", () => {
    const m = match({
      ft: [2, 1],
      goals: [[10, "home", "E. Haaland"], [50, "home", "E. Haaland"], [70, "away", "B. Saka", "Own Goal"]],
    });

    test("fuzzy-matches the player name", () => {
      expect(evaluateSelection(named("Anytime Goal Scorer", "Haaland"), m)).toBe("won");
      expect(evaluateSelection(named("Anytime Goal Scorer", "Saka"), m)).toBe("lost"); // own goals don't count
    });

    test("To Score 2 or More", () => {
      expect(evaluateSelection(named("To Score 2 or More", "E. Haaland"), m)).toBe("won");
    });
  });

  test("Goal in Interval checks the first goal", () => {
    const m = match({ ft: [1, 0], goals: [[14, "home"]] });
    expect(evaluateSelection(named("Goal in Interval", "11-20"), m)).toBe("won");
    expect(evaluateSelection(named("Goal in Interval", "0-10"), m)).toBe("lost");
  });

  test("Which team will score the 2nd goal", () => {
    const m = match({ ft: [1, 1], goals: [[10, "home"], [60, "away"]] });
    expect(evaluateSelection(named("Which team will score the 2nd goal?", "Away"), m)).toBe("won");
    expect(evaluateSelection(named("Which team will score the 3rd goal?", "No goal"), m)).toBe("won");
  });

  test("Last Team to Score", () => {
    const m = match({ ft: [2, 1], goals: [[10, "away"], [60, "home"], [88, "home"]] });
    expect(evaluateSelection(named("Last Team to Score (3 way)", "Home"), m)).toBe("won");
  });

  test("1st half label uses HT score", () => {
    const m = match({ ft: [0, 2], ht: [0, 0] });
    expect(evaluateSelection(named("1x2 (1st Half)", "Draw"), m)).toBe("won");
  });

  describe("statistics markets", () => {
    const stats = {
      totalCorners: 11, totalCards: 3, totalShotsOnGoal: 9,
      home: { corners: 7, totalCards: 1, shotsOnGoal: 6 },
      away: { corners: 4, totalCards: 2, shotsOnGoal: 3 },
    };

    test("corner and card over/under", () => {
      const m = match({ ft: [1, 0], stats });
      expect(evaluateSelection(named("Total Corners", "Over 10.5"), m)).toBe("won");
      expect(evaluateSelection(named("Home Corners", "Under 6.5"), m)).toBe("lost");
      expect(evaluateSelection(named("Total Cards", "Under 3.5"), m)).toBe("won");
    });

    test("race to N corners", () => {
      expect(evaluateSelection(named("Race to 5 Corners", "Home"), match({ ft: [1, 0], stats }))).toBe("won");
    });

    test("void without statistics", () => {
      expect(evaluateSelection(named("Total Corners", "Over 10.5"), match({ ft: [1, 0] }))).toBe("void");
    });
  });

  test("tournament markets are voided", () => {
    expect(evaluateSelection(named("To Qualify", "Home"), match({ ft: [1, 0] }))).toBe("void");
  });
});
