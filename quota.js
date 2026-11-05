// ============================================
// FANTASYBET API QUOTA — make a daily request allowance last the whole day
// ============================================
// API-Football sells requests per day: 100 on the free plan, thousands on paid ones. Polling
// live odds every 5 s and live scores every 15 s costs ~23,000 requests a day, so on a small
// plan the server switches to "budget" mode:
//
//   • only matches in followed leagues are tracked
//   • pre-match odds come first (they are what users bet on), a whole league per few requests
//     where that is cheaper, then live scores get the rest
//   • live scores are polled only while a followed match can be in play, and the interval is
//     chosen so the remaining requests last until the quota resets (00:00 UTC)
//   • live odds are not polled at all, so in-play betting is off (a feed minutes old would let
//     people bet on goals that already happened; the integrity guard refuses those bets anyway)
//
// Everything here is pure (time comes in as an argument) so the planning can be unit-tested
// and a whole match day can be simulated without calling the API.

const DAY_MS = 24 * 60 * 60 * 1000;
const MATCH_WINDOW_MS = 135 * 60 * 1000;   // kickoff → final whistle incl. half-time and stoppage
const MAX_WATCH_MS = 180 * 60 * 1000;      // give up on a match that is still "live" after 3 h
const PRE_KICKOFF_MS = 2 * 60 * 1000;      // start watching just before kickoff
const MAX_IDS_PER_CALL = 20;               // GET /fixtures?ids= takes at most 20 ids
const MIN_LIVE_INTERVAL_MS = 15 * 1000;    // never faster than the paid-plan engine
const MAX_LIVE_INTERVAL_MS = 30 * 60 * 1000;
const PREMATCH_SHARE = 0.5;                // at most half of the day's quota on pre-match odds
const PREMATCH_HORIZON_MS = 36 * 60 * 60 * 1000;  // fetch odds for matches starting in the next 36 h
const PREMATCH_REFRESH_MS = 20 * 60 * 60 * 1000;  // …at most once per match per ~day
const PREMATCH_RETRY_MS = 3 * 60 * 60 * 1000;     // no odds yet: ask again in 3 h (the API updates every 3 h)
const LEAGUE_BATCH_MIN = 3;                // this many due matches in one league → fetch the league's odds
const LEAGUE_PAGE_ESTIMATE = 3;            // pages a league request is expected to take (10 odds per page)
const FULL_MODE_MIN_LIMIT = 30000;         // the 5 s / 15 s engine needs ~25,000 requests a day

const FINISHED = new Set(["FT", "AET", "PEN"]);
const OVER = new Set(["FT", "AET", "PEN", "PST", "CANC", "ABD", "AWD", "WO"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE", "SUSP"]);

// Top leagues by API-Football id: Süper Lig, Premier League, La Liga, Bundesliga, Serie A,
// Ligue 1, Champions League, Europa League.
const DEFAULT_LEAGUES = [203, 39, 140, 78, 135, 61, 2, 3];

const utcDay = (t) => Math.floor(t / DAY_MS);
const dayEnd = (t) => (utcDay(t) + 1) * DAY_MS;
const kickoff = (m) => Date.parse(m.date);

/** "budget" below FULL_MODE_MIN_LIMIT requests a day, else "full" (the original 5 s / 15 s engine). */
function modeFor(dailyLimit) {
  return dailyLimit >= FULL_MODE_MIN_LIMIT ? "full" : "budget";
}

/** Leagues to follow from a comma-separated list of ids ("203,39"); the defaults when empty. */
function parseLeagues(text) {
  const ids = String(text || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return new Set(ids.length ? ids : DEFAULT_LEAGUES);
}

/**
 * Counts requests per UTC day. The API's own count (the x-ratelimit-requests-remaining header)
 * wins whenever a response carries it, so a restart or another client using the same key
 * cannot make the server overspend.
 */
function createBudget({ dailyLimit, reserve = 5, now = Date.now }) {
  let day = utcDay(now());
  let used = 0;
  let limit = dailyLimit;
  const spent = {};  // requests per purpose today, for the admin panel
  const roll = () => {
    const d = utcDay(now());
    if (d !== day) { day = d; used = 0; for (const k of Object.keys(spent)) delete spent[k]; }
  };
  return {
    get limit() { return limit; },
    get reserve() { return reserve; },
    used() { roll(); return used; },
    remaining() { roll(); return Math.max(0, limit - used); },
    /** Requests that planned work may use: everything except the reserve. */
    spendable() { roll(); return Math.max(0, limit - reserve - used); },
    /**
     * Takes n requests for `purpose` if they fit. Planned work stays out of the reserve;
     * `urgent` work (settling finished matches) may use it.
     */
    tryConsume(n = 1, purpose = "other", { urgent = false } = {}) {
      roll();
      if (used + n > (urgent ? limit : limit - reserve)) return false;
      used += n;
      spent[purpose] = (spent[purpose] || 0) + n;
      return true;
    },
    /** Applies the API's rate-limit headers. */
    sync({ remaining, limit: apiLimit }) {
      roll();
      if (Number.isFinite(apiLimit) && apiLimit > 0) limit = apiLimit;
      if (Number.isFinite(remaining) && remaining >= 0) used = Math.max(0, limit - remaining);
    },
    spentByPurpose() { roll(); return { ...spent }; },
  };
}

/** Matches worth tracking: in a followed league and not over. */
function tracked(matches, leagues) {
  return matches.filter((m) => leagues.has(m.league?.id) && !OVER.has(m.statusShort));
}

/** Matches that may be in play at `now`, so their score can change. */
function watchList(matches, now) {
  return matches.filter((m) => {
    if (OVER.has(m.statusShort)) return false;
    const k = kickoff(m);
    if (!Number.isFinite(k)) return false;
    if (LIVE.has(m.statusShort)) return now <= k + MAX_WATCH_MS;
    return now >= k - PRE_KICKOFF_MS && now <= k + MATCH_WINDOW_MS;
  });
}

/**
 * How many requests watching the rest of the day costs, per poll: the time integral of
 * ceil(matches in play / 20), in "call-milliseconds". Polling every T ms then costs callMs / T
 * requests. Matches already live count until MAX_WATCH_MS, upcoming ones for MATCH_WINDOW_MS.
 */
function watchCallMs(matches, now, until = dayEnd(now)) {
  const edges = [];
  for (const m of matches) {
    if (OVER.has(m.statusShort)) continue;
    const k = kickoff(m);
    if (!Number.isFinite(k)) continue;
    const start = Math.max(now, k - PRE_KICKOFF_MS);
    const end = Math.min(until, LIVE.has(m.statusShort) ? k + MAX_WATCH_MS : k + MATCH_WINDOW_MS);
    if (end <= start) continue;
    edges.push([start, 1], [end, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0, open = 0, last = now;
  for (const [t, d] of edges) {
    total += Math.ceil(open / MAX_IDS_PER_CALL) * (t - last);
    open += d;
    last = t;
  }
  return total;
}

/**
 * The live polling interval that makes `budget` requests last for the rest of the day.
 * Returns null when there is nothing to watch or no budget left.
 */
function liveIntervalMs({ matches, now, budget }) {
  const callMs = watchCallMs(matches, now);
  if (callMs <= 0 || budget <= 0) return null;
  return Math.min(MAX_LIVE_INTERVAL_MS, Math.max(MIN_LIVE_INTERVAL_MS, Math.ceil(callMs / budget)));
}

/** Upcoming matches whose pre-match odds are due, soonest kickoff first. */
function preMatchDue({ matches, now, fetchedAt }) {
  return matches
    .filter((m) => m.statusShort === "NS" || m.statusShort === "TBD")
    .filter((m) => { const k = kickoff(m); return k > now && k - now <= PREMATCH_HORIZON_MS; })
    .filter((m) => !(now < (fetchedAt.get(m.id) || 0) + PREMATCH_REFRESH_MS))
    .sort((a, b) => kickoff(a) - kickoff(b));
}

/**
 * What to request for pre-match odds now, within the pre-match share of today's quota.
 * GET /odds pages 10 matches per request, so a league with several due matches is cheaper to
 * fetch whole ({ kind: "league" }, ~LEAGUE_PAGE_ESTIMATE requests) than match by match
 * ({ kind: "fixture" }, 1 request each). Returns { units, allowance } — allowance in requests.
 *  fetchedAt: Map matchId → when its odds count as fetched (see PREMATCH_RETRY_MS)
 */
function preMatchPlan({ matches, now, fetchedAt, budget, limit, spentToday }) {
  const allowance = Math.max(0, Math.min(budget, Math.floor(limit * PREMATCH_SHARE) - spentToday));
  if (allowance === 0) return { units: [], allowance };
  const due = preMatchDue({ matches, now, fetchedAt });

  const byLeague = new Map();
  for (const m of due) {
    const key = m.league?.season ? `${m.league.id}:${m.league.season}` : null;
    if (key) byLeague.set(key, [...(byLeague.get(key) || []), m]);
  }
  const units = [];
  const inLeagueUnit = new Set();
  for (const group of byLeague.values()) {
    if (group.length < LEAGUE_BATCH_MIN) continue;
    units.push({ kind: "league", league: group[0].league.id, season: group[0].league.season, ids: group.map((m) => m.id), first: kickoff(group[0]) });
    for (const m of group) inLeagueUnit.add(m.id);
  }
  for (const m of due) if (!inLeagueUnit.has(m.id)) units.push({ kind: "fixture", ids: [m.id], first: kickoff(m) });
  units.sort((a, b) => a.first - b.first);

  // keep what fits; a league unit is counted at its estimate, and split into single matches
  // when the estimate no longer fits
  const out = [];
  let cost = 0;
  for (const u of units) {
    if (u.kind === "league" && cost + LEAGUE_PAGE_ESTIMATE <= allowance) {
      out.push(u);
      cost += LEAGUE_PAGE_ESTIMATE;
      continue;
    }
    for (const id of u.ids) {
      if (cost + 1 > allowance) break;
      out.push({ kind: "fixture", ids: [id], first: u.first });
      cost += 1;
    }
  }
  return { units: out, allowance };
}

/**
 * Requests pre-match odds will still want before the quota resets: matches entering the
 * horizon later today. Live polling leaves these alone so the odds aren't starved.
 */
function preMatchStillNeeded({ matches, now, fetchedAt, limit, spentToday }) {
  const shareLeft = Math.max(0, Math.floor(limit * PREMATCH_SHARE) - spentToday);
  const until = dayEnd(now) + PREMATCH_HORIZON_MS;
  const pending = matches.filter((m) => {
    if (m.statusShort !== "NS" && m.statusShort !== "TBD") return false;
    const k = kickoff(m);
    return k > now && k <= until && !(now < (fetchedAt.get(m.id) || 0) + PREMATCH_REFRESH_MS);
  });
  // a league with several pending matches costs about LEAGUE_PAGE_ESTIMATE requests, not one each
  const perLeague = new Map();
  for (const m of pending) perLeague.set(m.league?.id, (perLeague.get(m.league?.id) || 0) + 1);
  let need = 0;
  for (const n of perLeague.values()) need += n >= LEAGUE_BATCH_MIN ? Math.min(n, LEAGUE_PAGE_ESTIMATE) : n;
  return Math.min(shareLeft, need);
}

/** What a request is for, from its endpoint and parameters (for the per-purpose counts). */
function purposeOf(endpoint, params = {}) {
  if (endpoint === "status") return "status";  // free: does not count against the quota
  if (endpoint === "odds/live") return "liveOdds";
  if (endpoint === "odds") return "preMatch";
  if (endpoint === "fixtures" && (params.live || params.ids)) return "live";
  if (endpoint === "fixtures") return "fixtures";
  if (endpoint.startsWith("fixtures/")) return "settlement";
  return "other";
}

/** Splits ids into GET /fixtures?ids= batches. */
function idBatches(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_CALL) out.push(ids.slice(i, i + MAX_IDS_PER_CALL));
  return out;
}

module.exports = {
  createBudget, modeFor, parseLeagues, tracked, watchList, watchCallMs, liveIntervalMs, preMatchDue, preMatchPlan, preMatchStillNeeded, purposeOf, idBatches,
  utcDay, dayEnd, DEFAULT_LEAGUES, FULL_MODE_MIN_LIMIT, MAX_IDS_PER_CALL, MIN_LIVE_INTERVAL_MS, MAX_LIVE_INTERVAL_MS,
  PREMATCH_SHARE, PREMATCH_REFRESH_MS, PREMATCH_RETRY_MS, FINISHED, LIVE,
};
