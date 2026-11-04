// ============================================
// FANTASYBET PRICING — the server decides the odds of every bet
// ============================================
// The browser sends which outcome a user picked (match, market, pick) and the odds it showed.
// The price that counts is looked up here, from the server's own odds:
//   pre-match: the bookmaker odds stored on the match (match.bets)
//   in-play:   the live odds feed (currentLiveOdds), never the pre-match price
// If the user saw a different price than the current one, the bet is not placed; the client
// shows the new odds and the user decides again (the "odds changed" flow every bookmaker has).

/** Two prices are the same if they round to the same cent. */
function samePrice(a, b) {
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

/**
 * Looks up the current price of one selection.
 *  match:    the match from the server's state
 *  liveItem: the match's entry in the live odds feed, or null
 *  live:     whether the match is in play right now
 * Returns { odd, marketName, pick } or { error } with a message the user can see.
 */
function priceSelection(sel, { match, liveItem, live }) {
  const betId = Number(sel.betId);
  const pick = typeof sel.pick === "string" ? sel.pick : null;
  if (!Number.isInteger(betId) || !pick) return { error: "Invalid selection" };

  if (live) {
    // In play only the live feed is valid: the pre-match price no longer reflects the score.
    if (!liveItem) return { error: "Live odds not available for this match" };
    if (liveItem.fixtureStatus && (liveItem.fixtureStatus.stopped || liveItem.fixtureStatus.blocked)) {
      return { error: "Odds suspended for this selection" };
    }
    const market = (liveItem.odds || []).find((b) => b.id === betId);
    const value = market && (market.values || []).find((v) => v.value === pick);
    if (!value) return { error: "Selection no longer available" };
    if (value.suspended) return { error: "Odds suspended for this selection" };
    return checkedPrice(value.odd, market.name, pick);
  }

  const market = (match.bets || []).find((b) => b.id === betId);
  const value = market && (market.values || []).find((v) => v.value === pick);
  if (!value) return { error: "Selection no longer available" };
  return checkedPrice(value.odd, market.name, pick);
}

function checkedPrice(rawOdd, marketName, pick) {
  const odd = Number(rawOdd);
  if (!Number.isFinite(odd) || odd < 1.01) return { error: "Odds suspended for this selection" };
  return { odd: Math.round(odd * 100) / 100, marketName, pick };
}

module.exports = { priceSelection, samePrice };
