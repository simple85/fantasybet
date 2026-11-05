// ============================================
// FANTASYBET BET BUILDER — natural language → a bet slip, via Gemini function calling
// ============================================
// "Barcelona to win and over 2.5 goals in the Real game, 20 credits" becomes a proposed slip.
//
// The model never decides anything that matters:
//   * it finds matches and markets only through tools that read the server's own data
//   * propose_slip prices every selection with pricing.js and checks live bets with integrity.js,
//     exactly as placing a bet would; the proposal shown to the user is built by the server
//   * nothing is placed: the user adds the proposal to their bet slip and places it themselves
// So a confused or manipulated model can at worst propose a slip the user doesn't want.

const { GoogleGenAI, ThinkingLevel, FinishReason, ApiError } = require("@google/genai");
const pricing = require("./pricing");
const integrity = require("./integrity");

const MODEL = process.env.BET_BUILDER_MODEL || "gemini-3.6-flash";
const MAX_STEPS = 6;
const MIN_STAKE = 5;
const MAX_STAKE = 50000;
const MAX_RESULTS = 8;
const MAX_MARKETS = 15;
const MAX_PICKS = 12;

// USD per million tokens (Gemini API paid tier, prompts ≤200k): input, output incl. thinking, cached input
const PRICES = {
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
};

const SYSTEM_PROMPT = `You help users of FantasyBet, a fantasy football betting site played with free credits (no real money), turn what they want to bet on into a bet slip.

How to work:
- Find matches with find_matches and markets with list_markets. Never invent matches, markets, picks or odds; use the exact betId and pick strings the tools return.
- Search with full club names ("Barcelona", not "Barça"; "Manchester United", not "Man Utd"). If nothing is found, try another spelling once, then ask.
- If several matches or markets fit, ask which one the user means instead of guessing.
- When the slip is clear, call propose_slip with all selections and the stake (null if the user gave none). If it returns errors, fix them or explain them. The user sees the proposed slip as a card and adds it to their slip themselves: you cannot place bets, so never say a bet was placed.
- Several selections from the same match must use mode "system"; otherwise use "combined" unless the user asks for singles ("system").
- Do not give tips or predictions (who will win, what is a good bet). Say you can't predict results, and offer to show the odds.
- If the user seems to be chasing losses or upset about losing, gently suggest a break.
- Reply in the user's language (Turkish, English or German), in one to three short sentences. Plain text, no lists or markdown.`;

/* ── Search helpers ── */

/** Lowercase without accents, so "Beşiktaş" matches "besiktas" and "München" matches "munchen". */
function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .trim();
}

function formatKickoff(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

/* ── Tools ── */

function functionDeclarations() {
  return [
    {
      name: "find_matches",
      description: "Search upcoming and live matches by team or league name. Returns at most 8, soonest first.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "A team or league name, e.g. 'Galatasaray' or 'Premier League'" },
          day: { type: "string", enum: ["today", "tomorrow", "any"], description: "Restrict to today or tomorrow (user's time zone)" },
        },
        required: ["query", "day"],
        additionalProperties: false,
      },
    },
    {
      name: "list_markets",
      description: "The markets and current odds for one match. For live matches these are the live odds. Optionally filter by market name, e.g. 'goals', 'corners', 'double chance'.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          matchId: { type: "integer" },
          search: { type: ["string", "null"], description: "Part of a market name, or null for the main markets" },
        },
        required: ["matchId", "search"],
        additionalProperties: false,
      },
    },
    {
      name: "propose_slip",
      description: "Validate and price a bet slip with the current server odds. The user sees the result as a card and adds it to their slip themselves.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          selections: {
            type: "array",
            items: {
              type: "object",
              properties: { matchId: { type: "integer" }, betId: { type: "integer" }, pick: { type: "string" } },
              required: ["matchId", "betId", "pick"],
              additionalProperties: false,
            },
          },
          stake: { type: ["number", "null"], description: "Credits per bet (system: per selection), or null if the user gave none" },
          mode: { type: "string", enum: ["combined", "system"] },
        },
        required: ["selections", "stake", "mode"],
        additionalProperties: false,
      },
    },
  ];
}

function makeTools(deps, tz) {
  const { getMatches, getLiveOdds, isLive, isFinished, quoteBet, now = () => Date.now() } = deps;

  function marketsFor(match) {
    const live = isLive(match);
    const source = live ? (getLiveOdds().find((o) => o.fixtureId === match.id) || {}).odds || [] : match.bets || [];
    return { live, markets: source };
  }

  return {
    find_matches({ query, day }) {
      const q = normalize(query);
      if (q.length < 2) return { error: "Query too short" };
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now());
      const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now() + 86_400_000);
      const results = getMatches()
        .filter((m) => !isFinished(m))
        .filter((m) => [m.home?.name, m.away?.name, m.league?.name].some((n) => normalize(n).includes(q)))
        .filter((m) => {
          if (day === "any") return true;
          const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(m.date));
          return d === (day === "today" ? today : tomorrow);
        })
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .slice(0, MAX_RESULTS)
        .map((m) => ({
          matchId: m.id,
          home: m.home?.name,
          away: m.away?.name,
          league: m.league?.name,
          kickoff: formatKickoff(m.date, tz),
          status: isLive(m) ? "live" : "upcoming",
          ...(isLive(m) ? { minute: m.elapsed, score: m.score } : {}),
        }));
      return { matches: results };
    },

    list_markets({ matchId, search }) {
      const match = getMatches().find((m) => m.id === Number(matchId));
      if (!match || isFinished(match)) return { error: "Match not found or already finished" };
      const { live, markets } = marketsFor(match);
      const q = search ? normalize(search) : null;
      const chosen = markets
        .filter((b) => !q || normalize(b.name).includes(q))
        .slice(0, MAX_MARKETS)
        .map((b) => ({
          betId: b.id,
          name: b.name,
          picks: (b.values || []).filter((v) => !v.suspended).slice(0, MAX_PICKS).map((v) => ({ pick: v.value, odd: Number(v.odd) })),
        }))
        .filter((b) => b.picks.length > 0);
      return { matchId: match.id, match: `${match.home?.name} - ${match.away?.name}`, live, markets: chosen, ...(chosen.length === 0 ? { note: "No open markets match" } : {}) };
    },

    propose_slip({ selections, stake, mode }) {
      if (!Array.isArray(selections) || selections.length === 0) return { error: "No selections" };
      if (selections.length > 20) return { error: "At most 20 selections" };
      const ids = selections.map((s) => Number(s.matchId));
      if (mode === "combined" && new Set(ids).size < ids.length) {
        return { error: "Several selections from one match need mode 'system'" };
      }
      const priced = [];
      const errors = [];
      for (const sel of selections) {
        const match = getMatches().find((m) => m.id === Number(sel.matchId));
        if (!match || isFinished(match)) { errors.push({ ...sel, error: "Match not found or already finished" }); continue; }
        const live = isLive(match);
        const liveItem = live ? getLiveOdds().find((o) => o.fixtureId === match.id) : null;
        const price = pricing.priceSelection(sel, { match, liveItem, live });
        if (price.error) { errors.push({ ...sel, error: price.error }); continue; }
        if (live) {
          const check = integrity.checkLiveBet(match.id, match, now());
          if (!check.ok) { errors.push({ ...sel, error: check.error }); continue; }
        }
        priced.push({
          matchId: match.id,
          matchLabel: `${match.home?.name} - ${match.away?.name}`,
          betId: Number(sel.betId),
          marketLabel: price.marketName,
          pick: price.pick,
          pickLabel: price.pick,
          odd: price.odd,
        });
      }
      if (errors.length) return { error: "Some selections are not available", details: errors };

      let amount = stake == null ? null : Number(stake);
      if (amount != null && (!Number.isFinite(amount) || amount < MIN_STAKE || amount > MAX_STAKE)) {
        return { error: `Stake must be between ${MIN_STAKE} and ${MAX_STAKE} credits` };
      }
      const quote = quoteBet({ selections: priced, stake: amount ?? 1, mode });
      if (quote.error) return { error: quote.error };
      return {
        proposal: {
          mode: quote.mode,
          selections: priced,
          stake: amount,
          totalOdds: quote.mode === "combined" ? quote.totalOdds : null,
          possibleWin: amount != null ? quote.possibleWin : null,
        },
      };
    },
  };
}

/* ── Agent loop ── */

function costUsd(model, usage) {
  const p = PRICES[model];
  if (!p) return 0;
  const cached = usage.cachedContentTokenCount || 0;
  const input = (usage.promptTokenCount || 0) - cached;
  const output = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  return Math.round(((input * p.input + cached * p.cached + output * p.output) / 1e6) * 1e6) / 1e6;
}

/**
 * One user message → { reply, proposal, notice }.
 *  history: earlier turns as [{ role: "user"|"model", text }] (text only; each turn re-reads live data)
 *  slip:    the proposal currently shown to the user, so "make it 50 credits" works
 */
async function runBetBuilder({ message, history = [], slip = null, lang = "en", tz = "Europe/Istanbul" }, deps) {
  const tools = makeTools(deps, tz);
  const contents = history.map((h) => ({ role: h.role === "model" ? "model" : "user", parts: [{ text: h.text }] }));
  const context = slip ? `\n\n[Slip currently proposed to me: ${JSON.stringify(slip.selections.map((s) => ({ matchId: s.matchId, betId: s.betId, pick: s.pick })))}, stake ${slip.stake ?? "not set"}, mode ${slip.mode}]` : "";
  contents.push({ role: "user", parts: [{ text: message + context }] });

  const system = `${SYSTEM_PROMPT}\n\nNow: ${formatKickoff(deps.now ? deps.now() : Date.now(), tz)} (${tz}). Interface language: ${lang}.`;
  let proposal = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const started = Date.now();
    const response = await deps.generate({
      model: MODEL,
      contents: [...contents],
      config: {
        systemInstruction: system,
        tools: [{ functionDeclarations: functionDeclarations() }],
        automaticFunctionCalling: { disable: true },
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: 4096,
      },
    });
    const candidate = response.candidates && response.candidates[0];
    const finish = candidate && candidate.finishReason;
    await deps.onUsage?.({
      model: response.modelVersion || MODEL,
      inputTokens: response.usageMetadata?.promptTokenCount || 0,
      outputTokens: (response.usageMetadata?.candidatesTokenCount || 0) + (response.usageMetadata?.thoughtsTokenCount || 0),
      costUsd: costUsd(MODEL, response.usageMetadata || {}),
      latencyMs: Date.now() - started,
      outcome: finish || response.promptFeedback?.blockReason || null,
    });

    if (response.promptFeedback?.blockReason || [FinishReason.SAFETY, FinishReason.PROHIBITED_CONTENT, FinishReason.BLOCKLIST].includes(finish)) {
      return { reply: null, proposal, notice: "refused" };
    }
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    if (parts.length === 0 || finish === FinishReason.MALFORMED_FUNCTION_CALL) {
      return { reply: null, proposal, notice: "model_error" };
    }
    contents.push({ role: "model", parts }); // unchanged, so thought signatures go back as they came

    const calls = parts.filter((p) => p.functionCall && p.functionCall.name).map((p) => p.functionCall);
    if (calls.length === 0) {
      const reply = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
      return { reply: reply || null, proposal, notice: null };
    }

    const results = calls.map((call) => {
      const tool = tools[call.name];
      let result;
      try {
        result = tool ? tool(call.args || {}) : { error: `Unknown tool ${call.name}` };
      } catch (e) {
        console.error(`[BET-BUILDER] ${call.name} failed:`, e.message);
        result = { error: "Server error" };
      }
      if (call.name === "propose_slip" && result.proposal) proposal = result.proposal;
      return { functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: result } };
    });
    contents.push({ role: "user", parts: results });
  }
  return { reply: null, proposal, notice: "step_limit" };
}

function geminiGenerate() {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 30_000, retryOptions: { attempts: 2 } } });
  return (params) => client.models.generateContent(params);
}

/** Maps a failed call to a code the app can show. */
function errorCode(err) {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403 || (err.status === 400 && /API key/i.test(err.message))) return "not_configured";
    if (err.status === 429 || err.status === 503) return "busy";
    return "upstream";
  }
  if (err && (err.name === "AbortError" || /timed? ?out|aborted/i.test(err.message || ""))) return "timeout";
  return "internal";
}

module.exports = { runBetBuilder, makeTools, normalize, geminiGenerate, errorCode, costUsd, MODEL, MIN_STAKE, MAX_STAKE };
