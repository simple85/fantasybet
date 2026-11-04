// ============================================
// FANTASYBET INTEGRITY GUARD — stops past-posting on live bets
// ============================================
// Past-posting: betting on something that has already happened. A goal is scored, the bettor
// sees it (TV is faster than our feed), and bets on the old price before our odds react.
//
// What the server knows and when:
//   live odds feed     every 5 s   (noteOddsTick, noteOddsChanged)
//   live scores/cards  every 15 s  (noteLiveUpdate → an "incident" when the score or red cards change)
// A live bet is refused when
//   1. the odds feed itself is lagging (feedAgeMs > FEED_MAX_AGE_MS),
//   2. an incident happened less than INCIDENT_COOLDOWN_MS ago, or
//   3. the match's odds haven't changed since its last incident (still the pre-goal prices).
// Every accepted live selection carries a snapshot of these timings, so the offline detection
// (ml/integrity) can look back at how close to an incident each bet was placed.

const FEED_MAX_AGE_MS = 20_000;
const INCIDENT_COOLDOWN_MS = 30_000;

let lastOddsTickAt = 0;          // last successful live odds fetch
const oddsChangedAt = new Map(); // fixtureId → when its odds last changed
const incidents = new Map();     // fixtureId → { at, kind, minute, score, redCards }
const lastSeen = new Map();      // fixtureId → { score, redCards } from the previous score update

function noteOddsTick(now = Date.now()) {
  lastOddsTickAt = now;
}

function noteOddsChanged(fixtureId, now = Date.now()) {
  oddsChangedAt.set(Number(fixtureId), now);
}

/** Called with every live score update; records a goal or red card as an incident. */
function noteLiveUpdate(fixtureId, { score, redCards, elapsed }, now = Date.now()) {
  const id = Number(fixtureId);
  const prev = lastSeen.get(id);
  const current = { score: score || null, redCards: redCards || null };
  lastSeen.set(id, current);
  if (!prev) return null; // first sighting: nothing to compare against

  const goals = (s) => (s ? (s.home || 0) + (s.away || 0) : 0);
  const reds = (r) => (r ? (r.home || 0) + (r.away || 0) : 0);
  let kind = null;
  if (goals(current.score) !== goals(prev.score)) kind = "goal";
  else if (reds(current.redCards) > reds(prev.redCards)) kind = "red_card";
  if (!kind) return null;

  const incident = { at: now, kind, minute: elapsed ?? null, score: current.score };
  incidents.set(id, incident);
  return incident;
}

/**
 * Whether a live bet on this fixture may be placed right now.
 * Returns { ok: true, snapshot } or { ok: false, rule, error, snapshot }.
 */
function checkLiveBet(fixtureId, match, now = Date.now()) {
  const id = Number(fixtureId);
  const incident = incidents.get(id) || null;
  const changedAt = oddsChangedAt.get(id) ?? null;
  const snapshot = {
    minute: match?.elapsed ?? null,
    score: match?.score ?? null,
    feedAgeMs: lastOddsTickAt ? now - lastOddsTickAt : null,
    oddsAgeMs: changedAt != null ? now - changedAt : null,
    msSinceIncident: incident ? now - incident.at : null,
    lastIncident: incident ? incident.kind : null,
  };

  if (!lastOddsTickAt || now - lastOddsTickAt > FEED_MAX_AGE_MS) {
    return { ok: false, rule: "feed_delayed", error: "Live odds are delayed, please try again shortly", snapshot };
  }
  if (incident && now - incident.at < INCIDENT_COOLDOWN_MS) {
    return { ok: false, rule: "incident_cooldown", error: "Market briefly closed after a goal or red card", snapshot };
  }
  if (incident && (changedAt == null || changedAt <= incident.at)) {
    return { ok: false, rule: "odds_not_updated", error: "Waiting for updated odds after a goal or red card", snapshot };
  }
  return { ok: true, snapshot };
}

/** Forget fixtures that are no longer live. */
function forgetFixture(fixtureId) {
  const id = Number(fixtureId);
  oddsChangedAt.delete(id);
  incidents.delete(id);
  lastSeen.delete(id);
}

function __reset() {
  lastOddsTickAt = 0;
  oddsChangedAt.clear();
  incidents.clear();
  lastSeen.clear();
}

module.exports = {
  FEED_MAX_AGE_MS,
  INCIDENT_COOLDOWN_MS,
  noteOddsTick,
  noteOddsChanged,
  noteLiveUpdate,
  checkLiveBet,
  forgetFixture,
  __reset,
};
