const { computeBetOutcome } = require("../server");

const leg = (result, odd) => ({ result, odd });

describe("combined bets", () => {
  const bet = (selections, extra = {}) => ({
    mode: "combined", stake: 10, totalOdds: 6, possibleWin: 60, selections, ...extra,
  });

  test("all legs won pays possibleWin", () => {
    expect(computeBetOutcome(bet([leg("won", 2), leg("won", 3)]))).toEqual({
      status: "won", payout: 60, finalOdds: 6, finalWin: 60,
    });
  });

  test("one lost leg loses the whole bet", () => {
    expect(computeBetOutcome(bet([leg("won", 2), leg("lost", 3)]))).toMatchObject({ status: "lost", payout: 0 });
  });

  test("void legs count as odds 1.0", () => {
    expect(computeBetOutcome(bet([leg("won", 2), leg("void", 3)]))).toEqual({
      status: "won", payout: 20, finalOdds: 2, finalWin: 20,
    });
  });

  test("all legs void refunds the stake", () => {
    expect(computeBetOutcome(bet([leg("void", 2), leg("void", 3)]))).toMatchObject({ status: "void", payout: 10 });
  });

  test("lost beats void", () => {
    expect(computeBetOutcome(bet([leg("void", 2), leg("lost", 3)]))).toMatchObject({ status: "lost", payout: 0 });
  });

  test("payout is rounded to cents", () => {
    const result = computeBetOutcome(bet([leg("won", 1.333), leg("void", 2)], { stake: 3 }));
    expect(result.payout).toBe(4);
    expect(result.finalOdds).toBe(1.33);
  });
});

describe("system bets (each selection is a single bet)", () => {
  const bet = (selections) => ({ mode: "system", stake: 5, totalOdds: 0, possibleWin: 0, selections });

  test("sums winning singles and refunds voids", () => {
    expect(computeBetOutcome(bet([leg("won", 2), leg("lost", 3), leg("void", 4)]))).toMatchObject({
      status: "won", payout: 15, finalWin: 15,
    });
  });

  test("all lost", () => {
    expect(computeBetOutcome(bet([leg("lost", 2), leg("lost", 3)]))).toMatchObject({ status: "lost", payout: 0 });
  });

  test("only voids", () => {
    expect(computeBetOutcome(bet([leg("void", 2), leg("void", 3)]))).toMatchObject({ status: "void", payout: 10 });
  });

  test("voids and losses without a win are void with partial refund", () => {
    expect(computeBetOutcome(bet([leg("void", 2), leg("lost", 3)]))).toMatchObject({ status: "void", payout: 5 });
  });
});

describe("quoteBet (server-side stake and payout)", () => {
  const { quoteBet } = require("../server");
  const sel = (odd) => ({ odd });

  test("combined: payout is stake × product of odds", () => {
    expect(quoteBet({ selections: [sel(2), sel(1.5)], stake: 10 })).toEqual({
      mode: "combined", stake: 10, totalCost: 10, totalOdds: 3, possibleWin: 30,
    });
  });

  test("system: each selection is a single bet of the stake", () => {
    expect(quoteBet({ selections: [sel(2), sel(3)], stake: 5, mode: "system" })).toEqual({
      mode: "system", stake: 5, totalCost: 10, totalOdds: 0, possibleWin: 25,
    });
  });

  test.each([
    [{ selections: [sel(2)], stake: -1 }, "Stake must be a positive amount"],
    [{ selections: [sel(2)], stake: "1e400" }, "Stake must be a positive amount"],
    [{ selections: [sel(0.9)], stake: 1 }, "Invalid odds"],
    [{ selections: [sel(2)], stake: 1, mode: "lottery" }, "Invalid bet mode"],
  ])("rejects %j", (input, error) => {
    expect(quoteBet(input)).toEqual({ error });
  });
});
