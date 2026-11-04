// Live evals for the bet builder: real Gemini, fixed match data, checks on what it PRODUCES
// (the server-built proposal), not on its wording. Costs well under a cent per run.
//
//   GEMINI_API_KEY=... npm run eval:bet-builder

const { runBetBuilder, geminiGenerate, MODEL } = require("../betBuilder");
const { quoteBet } = require("../server");

const NOW = Date.parse("2026-11-04T15:00:00Z");
const odds = (h, d, a) => [
  { id: 1, name: "Match Winner", values: [{ value: "Home", odd: h }, { value: "Draw", odd: d }, { value: "Away", odd: a }] },
  { id: 5, name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "1.90" }, { value: "Under 2.5", odd: "1.90" }] },
  { id: 8, name: "Both Teams Score", values: [{ value: "Yes", odd: "1.70" }, { value: "No", odd: "2.05" }] },
];
const M = (id, home, away, league, hoursFromNow, prices) => ({
  id, date: new Date(NOW + hoursFromNow * 3600e3).toISOString(), status: "Not Started", statusShort: "NS",
  league: { name: league }, home: { name: home }, away: { name: away }, bets: odds(...prices),
});
const MATCHES = [
  M(1, "Galatasaray", "Beşiktaş", "Süper Lig", 4, ["1.85", "3.60", "4.20"]),
  M(2, "Barcelona", "Real Madrid", "La Liga", 6, ["2.10", "3.50", "3.30"]),
  M(3, "Bayern München", "Borussia Dortmund", "Bundesliga", 28, ["1.55", "4.40", "5.50"]),
  M(4, "Manchester United", "Liverpool", "Premier League", 27, ["3.10", "3.60", "2.25"]),
];

const sel = (p, matchId, betId, pick) => p && p.selections.some((s) => s.matchId === matchId && s.betId === betId && s.pick === pick);
const CASES = [
  { id: "tr-single", lang: "tr", message: "Galatasaray kazanır, 20 kredi", check: (r) => sel(r.proposal, 1, 1, "Home") && r.proposal.stake === 20 },
  { id: "en-two-legs", lang: "en", message: "Barça to beat Real and over 2.5 goals in the Bayern game, 15 credits",
    check: (r) => sel(r.proposal, 2, 1, "Home") && sel(r.proposal, 3, 5, "Over 2.5") && r.proposal.stake === 15 && r.proposal.mode === "combined" },
  { id: "de-btts", lang: "de", message: "Beide Teams treffen bei Man United gegen Liverpool", check: (r) => sel(r.proposal, 4, 8, "Yes") },
  { id: "same-match-system", lang: "en", message: "Galatasaray win and over 2.5 in the same match, 10 each",
    check: (r) => r.proposal && r.proposal.mode === "system" && r.proposal.selections.length === 2 },
  { id: "no-tips", lang: "en", message: "Who will win Barcelona vs Real Madrid? Give me a sure bet", check: (r) => !r.proposal },
  { id: "unknown-team", lang: "en", message: "Bet 10 on Atlantis FC to win", check: (r) => !r.proposal },
];

async function main() {
  if (!process.env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY is not set"); process.exit(2); }
  const generate = geminiGenerate();
  let passed = 0, cost = 0, calls = 0;
  for (const c of CASES) {
    const usage = [];
    try {
      const r = await runBetBuilder({ message: c.message, lang: c.lang, tz: "Europe/Istanbul" }, {
        generate, getMatches: () => MATCHES, getLiveOdds: () => [], isLive: () => false, isFinished: () => false, quoteBet, now: () => NOW,
        onUsage: (u) => usage.push(u),
      });
      const ok = Boolean(c.check(r));
      passed += ok;
      console.log(`${ok ? "PASS" : "FAIL"}  ${c.id}${ok ? "" : `\n      reply: ${r.reply}\n      proposal: ${JSON.stringify(r.proposal)}`}`);
    } catch (e) {
      console.log(`ERROR ${c.id}: ${e.message}`);
    }
    cost += usage.reduce((s, u) => s + u.costUsd, 0);
    calls += usage.length;
  }
  console.log(`\n${MODEL}: ${passed}/${CASES.length} passed, ${calls} model calls, $${cost.toFixed(4)}`);
  process.exit(passed === CASES.length ? 0 : 1);
}

main();
