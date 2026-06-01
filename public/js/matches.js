// ============================================
// FRONTEND MATCH DATA LOADER
// ============================================
// Loads from server API, falls back to mock data

let _matchesCache = null;
let _lastFetch = null;

async function getMatches() {
  if (_matchesCache && _lastFetch && (Date.now() - _lastFetch) < 60000) {
    return _matchesCache;
  }
  try {
    const res = await fetch("/api/matches");
    if (res.ok) {
      const data = await res.json();
      if (data.matches && data.matches.length > 0) {
        console.log("Loaded " + data.matches.length + " matches from API");
        // Return the full response (includes liveOdds) but also keep matches array accessible via .filter etc.
        const result = data.matches;
        result.liveOdds = data.liveOdds || [];
        _matchesCache = result;
        _lastFetch = Date.now();
        return result;
      }
    }
  } catch (e) {
    console.log("API not available, using mock data");
  }
  const mock = getMockMatches();
  mock.liveOdds = [];
  return mock;
}

function getMockMatches() {
  const now = new Date();
  const later = (h) => new Date(now.getTime() + h * 3600000).toISOString();

  return [
    {
      id: 99001,
      league: { id: 203, name: "Super Lig", country: "Turkey", logo: "", flag: "" },
      date: later(3),
      status: "Not Started",
      home: { id: 1001, name: "Galatasaray", logo: "" },
      away: { id: 1002, name: "Fenerbahce", logo: "" },
      bets: [
        { id: 1, name: "Match Winner", values: [
          { value: "Home", odd: "2.10" }, { value: "Draw", odd: "3.40" }, { value: "Away", odd: "3.25" }
        ]},
        { id: 5, name: "Goals Over/Under", values: [
          { value: "Over 2.5", odd: "1.85" }, { value: "Under 2.5", odd: "1.95" },
          { value: "Over 1.5", odd: "1.28" }, { value: "Under 1.5", odd: "3.60" },
          { value: "Over 3.5", odd: "3.10" }, { value: "Under 3.5", odd: "1.36" }
        ]},
        { id: 8, name: "Both Teams Score", values: [
          { value: "Yes", odd: "1.72" }, { value: "No", odd: "2.05" }
        ]},
        { id: 12, name: "Double Chance", values: [
          { value: "Home/Draw", odd: "1.30" }, { value: "Draw/Away", odd: "1.58" }, { value: "Home/Away", odd: "1.22" }
        ]},
        { id: 13, name: "First Half Winner", values: [
          { value: "Home", odd: "2.70" }, { value: "Draw", odd: "2.20" }, { value: "Away", odd: "3.80" }
        ]},
        { id: 21, name: "Odd/Even", values: [
          { value: "Odd", odd: "1.98" }, { value: "Even", odd: "1.88" }
        ]},
        { id: 10, name: "Exact Score", values: [
          { value: "1:0", odd: "6.50" }, { value: "2:0", odd: "7.00" }, { value: "2:1", odd: "9.00" },
          { value: "0:0", odd: "10.00" }, { value: "1:1", odd: "8.00" }, { value: "0:1", odd: "15.00" },
          { value: "0:2", odd: "29.00" }, { value: "1:2", odd: "19.00" }, { value: "3:0", odd: "10.00" },
          { value: "3:1", odd: "13.00" }, { value: "2:2", odd: "19.00" }
        ]},
        { id: 36, name: "Anytime Goal Scorer", values: [
          { value: "M. Icardi", odd: "2.50" }, { value: "M. Batshuayi", odd: "3.20" },
          { value: "E. Dzeko", odd: "2.90" }, { value: "K. Akturkoglu", odd: "3.80" }
        ]},
      ]
    },
    {
      id: 99002,
      league: { id: 39, name: "Premier League", country: "England", logo: "", flag: "" },
      date: later(5),
      status: "Not Started",
      home: { id: 2001, name: "Arsenal", logo: "" },
      away: { id: 2002, name: "Chelsea", logo: "" },
      bets: [
        { id: 1, name: "Match Winner", values: [
          { value: "Home", odd: "1.90" }, { value: "Draw", odd: "3.60" }, { value: "Away", odd: "3.80" }
        ]},
        { id: 5, name: "Goals Over/Under", values: [
          { value: "Over 2.5", odd: "1.75" }, { value: "Under 2.5", odd: "2.05" },
          { value: "Over 1.5", odd: "1.22" }, { value: "Under 1.5", odd: "4.00" },
          { value: "Over 3.5", odd: "2.90" }, { value: "Under 3.5", odd: "1.40" }
        ]},
        { id: 8, name: "Both Teams Score", values: [
          { value: "Yes", odd: "1.65" }, { value: "No", odd: "2.15" }
        ]},
        { id: 12, name: "Double Chance", values: [
          { value: "Home/Draw", odd: "1.22" }, { value: "Draw/Away", odd: "1.70" }, { value: "Home/Away", odd: "1.18" }
        ]},
        { id: 13, name: "First Half Winner", values: [
          { value: "Home", odd: "2.40" }, { value: "Draw", odd: "2.10" }, { value: "Away", odd: "4.50" }
        ]},
        { id: 45, name: "Corners Over Under", values: [
          { value: "Over 9.5", odd: "1.85" }, { value: "Under 9.5", odd: "1.95" },
          { value: "Over 10.5", odd: "2.30" }, { value: "Under 10.5", odd: "1.55" }
        ]},
      ]
    },
    {
      id: 99003,
      league: { id: 140, name: "La Liga", country: "Spain", logo: "", flag: "" },
      date: later(7),
      status: "Not Started",
      home: { id: 3001, name: "Real Madrid", logo: "" },
      away: { id: 3002, name: "Barcelona", logo: "" },
      bets: [
        { id: 1, name: "Match Winner", values: [
          { value: "Home", odd: "2.40" }, { value: "Draw", odd: "3.50" }, { value: "Away", odd: "2.70" }
        ]},
        { id: 5, name: "Goals Over/Under", values: [
          { value: "Over 2.5", odd: "1.70" }, { value: "Under 2.5", odd: "2.10" },
          { value: "Over 1.5", odd: "1.18" }, { value: "Under 1.5", odd: "4.50" },
          { value: "Over 3.5", odd: "2.70" }, { value: "Under 3.5", odd: "1.45" }
        ]},
        { id: 8, name: "Both Teams Score", values: [
          { value: "Yes", odd: "1.60" }, { value: "No", odd: "2.25" }
        ]},
        { id: 12, name: "Double Chance", values: [
          { value: "Home/Draw", odd: "1.40" }, { value: "Draw/Away", odd: "1.48" }, { value: "Home/Away", odd: "1.20" }
        ]},
        { id: 36, name: "Anytime Goal Scorer", values: [
          { value: "Vinicius Jr", odd: "2.60" }, { value: "K. Mbappe", odd: "2.20" },
          { value: "R. Lewandowski", odd: "2.40" }, { value: "L. Yamal", odd: "4.00" },
          { value: "J. Bellingham", odd: "3.50" }, { value: "Raphinha", odd: "3.80" }
        ]},
      ]
    },
    {
      id: 99004,
      league: { id: 78, name: "Bundesliga", country: "Germany", logo: "", flag: "" },
      date: later(2),
      status: "Not Started",
      home: { id: 4001, name: "Bayern Munchen", logo: "" },
      away: { id: 4002, name: "Borussia Dortmund", logo: "" },
      bets: [
        { id: 1, name: "Match Winner", values: [
          { value: "Home", odd: "1.55" }, { value: "Draw", odd: "4.20" }, { value: "Away", odd: "5.50" }
        ]},
        { id: 5, name: "Goals Over/Under", values: [
          { value: "Over 2.5", odd: "1.60" }, { value: "Under 2.5", odd: "2.25" },
          { value: "Over 3.5", odd: "2.50" }, { value: "Under 3.5", odd: "1.50" }
        ]},
        { id: 8, name: "Both Teams Score", values: [
          { value: "Yes", odd: "1.65" }, { value: "No", odd: "2.15" }
        ]},
        { id: 14, name: "Team To Score First", values: [
          { value: "Home", odd: "1.40" }, { value: "Draw", odd: "11.00" }, { value: "Away", odd: "3.20" }
        ]},
      ]
    },
    {
      id: 99005,
      league: { id: 135, name: "Serie A", country: "Italy", logo: "", flag: "" },
      date: later(4),
      status: "Not Started",
      home: { id: 5001, name: "Inter", logo: "" },
      away: { id: 5002, name: "AC Milan", logo: "" },
      bets: [
        { id: 1, name: "Match Winner", values: [
          { value: "Home", odd: "1.80" }, { value: "Draw", odd: "3.60" }, { value: "Away", odd: "4.20" }
        ]},
        { id: 5, name: "Goals Over/Under", values: [
          { value: "Over 2.5", odd: "1.78" }, { value: "Under 2.5", odd: "2.02" }
        ]},
        { id: 8, name: "Both Teams Score", values: [
          { value: "Yes", odd: "1.68" }, { value: "No", odd: "2.12" }
        ]},
      ]
    },
  ];
}
