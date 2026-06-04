// ============================================
// BETZONE CONFIG
// ============================================
// Users are now managed server-side via /api/users
// Admin panel handles user CRUD at admin.html

// Admin credentials are stored in .env (ADMIN_ID, ADMIN_PASSWORD)
// and checked server-side via /api/auth/login

// Varsayilan dil / Default language
const DEFAULT_LANG = "tr";

// Site adi / Site name
const SITE_NAME = "BetZone";

// Minimum bahis miktari / Minimum bet amount
const MIN_BET = 5;

// Maksimum bahis miktari / Maximum bet amount
const MAX_BET = 50000;

// ── League priority (from lig_siralamasi.xlsx) ──
// Key = "LeagueName|Country" or just "LeagueName" for unique names
// Value = priority (lower = higher priority)
// Leagues NOT in this map get priority 9999 and sort alphabetically
const LEAGUE_PRIORITY = {
  // 1-4: UEFA Club Tournaments
  "Champions League|World": 1, "UEFA Champions League|World": 1,
  "Europa League|World": 2, "UEFA Europa League|World": 2,
  "Europa Conference League|World": 3, "UEFA Europa Conference League|World": 3,
  "UEFA Super Cup|World": 4,
  // 5-8: Turkey
  "Süper Lig|Turkey": 5, "Super Lig|Turkey": 5,
  "Turkish Cup|Turkey": 6, "Ziraat Türkiye Kupası|Turkey": 6,
  "TFF Super Cup|Turkey": 7, "TFF Süper Kupa|Turkey": 7,
  "TFF 1. Lig|Turkey": 8,
  // 9-13: England
  "Premier League|England": 9,
  "FA Cup|England": 10, "The FA Cup|England": 10,
  "Carabao Cup|England": 11, "EFL Cup|England": 11,
  "FA Community Shield|England": 12, "Community Shield|England": 12,
  "Championship|England": 13, "EFL Championship|England": 13,
  // 14-17: Spain
  "La Liga|Spain": 14, "LaLiga|Spain": 14, "Liga|Spain": 14,
  "Copa del Rey|Spain": 15,
  "Supercopa de España|Spain": 16, "Spanish Super Cup|Spain": 16,
  "La Liga 2|Spain": 17, "LaLiga 2|Spain": 17,
  // 18-21: Germany
  "Bundesliga|Germany": 18,
  "DFB-Pokal|Germany": 19, "DFB Pokal|Germany": 19,
  "DFL-Supercup|Germany": 20, "DFL Supercup|Germany": 20,
  "2. Bundesliga|Germany": 21,
  // 22-25: Italy
  "Serie A|Italy": 22,
  "Coppa Italia|Italy": 23,
  "Supercoppa Italiana|Italy": 24,
  "Serie B|Italy": 25,
  // 26-29: France
  "Ligue 1|France": 26,
  "Coupe de France|France": 27,
  "Trophée des Champions|France": 28,
  "Ligue 2|France": 29,
  // 30-35: National Team Tournaments
  "World Cup|World": 30, "FIFA World Cup|World": 30,
  "World Cup Qualifiers|World": 31, "WC Qualification Europe|World": 31,
  "Euro Championship|World": 32, "EURO|World": 32,
  "Euro Championship - Qualification|World": 33,
  "UEFA Nations League|World": 34, "Nations League|World": 34,
  "Club World Cup|World": 35, "FIFA Club World Cup|World": 35,
  // 36-51: Other European Leagues
  "Eredivisie|Netherlands": 36,
  "Primeira Liga|Portugal": 37, "Liga Portugal|Portugal": 37,
  "Jupiler Pro League|Belgium": 38, "Pro League|Belgium": 38,
  "Premiership|Scotland": 39, "Scottish Premiership|Scotland": 39,
  "Bundesliga|Austria": 40,
  "Super League|Switzerland": 41,
  "Super League 1|Greece": 42,
  "Superligaen|Denmark": 43, "Superliga|Denmark": 43,
  "HNL|Croatia": 44, "Prva HNL|Croatia": 44, "First NL|Croatia": 44,
  "Super Liga|Serbia": 45, "SuperLiga|Serbia": 45, "Prva Liga|Serbia": 45,
  "First League|Czech-Republic": 46, "Chance Liga|Czech-Republic": 46, "3. liga - MSFL|Czech-Republic": 46,
  "Ekstraklasa|Poland": 47,
  "Liga I|Romania": 48, "Liga 1|Romania": 48,
  "Allsvenskan|Sweden": 49,
  "Eliteserien|Norway": 50,
  "Premier League|Ukraine": 51,
  // 52-57: Non-European
  "Saudi Professional League|Saudi-Arabia": 52, "Pro League|Saudi-Arabia": 52,
  "Serie A|Brazil": 53, "Brasileiro|Brazil": 53,
  "Liga Profesional|Argentina": 54, "Primera División|Argentina": 54,
  "Major League Soccer|USA": 55, "MLS|USA": 55,
  "Liga MX|Mexico": 56,
  "CONMEBOL Libertadores|World": 57, "Copa Libertadores|World": 57,
  "CONMEBOL Sudamericana|World": 58,
  // 59-89: Remaining European Leagues
  "1st Division|Albania": 59, "Kategoria Superiore|Albania": 59,
  "Premyer Liqa|Azerbaijan": 60,
  "Premier League|Belarus": 61,
  "Premijer Liga|Bosnia": 62, "Premijer Liga|Bosnia-And-Herzegovina": 62,
  "First League|Bulgaria": 63, "First Professional League|Bulgaria": 63,
  "National League|Gibraltar": 64,
  "Premier League|Armenia": 65,
  "Meistriliiga|Estonia": 66,
  "Meistaradeildin|Faroe-Islands": 67, "Betri Deildin|Faroe-Islands": 67,
  "Veikkausliiga|Finland": 68, "Ykkösliiga|Finland": 68,
  "Cymru Premier|Wales": 69,
  "Erovnuli Liga|Georgia": 70,
  "Premier Division|Ireland": 71, "First Division|Ireland": 71,
  "Ligat Ha'Al|Israel": 72, "Premier League|Israel": 72,
  "Úrvalsdeild|Iceland": 73, "Besta Deild|Iceland": 73,
  "First League|Montenegro": 74,
  "Premier League|Kazakhstan": 75,
  "1st Division|Cyprus": 76,
  "Superliga|Kosovo": 77,
  "Premiership|Northern-Ireland": 78, "NIFL Premiership|Northern-Ireland": 78,
  "First League|North-Macedonia": 79,
  "Virsliga|Latvia": 80,
  "A Lyga|Lithuania": 81,
  "National Division|Luxembourg": 82, "Cup|Luxembourg": 82,
  "NB I|Hungary": 83,
  "Premier League|Malta": 84,
  "Divizia Nationala|Moldova": 85,
  "Premier League|Russia": 86,
  "Campionato Sammarinese|San-Marino": 87,
  "Super Liga|Slovakia": 88, "Fortuna Liga|Slovakia": 88,
  "PrvaLiga|Slovenia": 89,
};

function getLeaguePriority(leagueName, country) {
  // Exact match: "name|country"
  const key = leagueName + "|" + country;
  if (LEAGUE_PRIORITY[key] !== undefined) return LEAGUE_PRIORITY[key];
  return 9999;
}

// ── Bet category definitions ──
// Maps API-Football bet IDs to UI categories
const BET_CATEGORIES = [
  {
    id: "result",
    betIds: [1, 2, 12, 13, 3, 7, 20, 14, 15],
    // Match Winner, Home/Away, Double Chance, 1st/2nd Half Winner,
    // HT/FT, DC 1st Half, Team To Score First/Last
  },
  {
    id: "goals",
    betIds: [5, 6, 72, 17, 18, 16, 8, 25, 26, 29],
    // Goals O/U, Goals O/U 1st/2nd Half,
    // Total Home/Away Goals, Exact Goals, BTS, BTS 1st/2nd, Result/Total 1st Half
  },
  {
    id: "score",
    betIds: [10, 31],
    // Exact Score, Correct Score 1st Half
  },
  {
    id: "handicap",
    betIds: [51, 87, 4, 19],
    // European Handicap, Handicap 1st Half European, Asian Handicap, AH 1st Half
  },
  {
    id: "corners",
    betIds: [45, 47, 48, 49, 77, 85],
    // Corners O/U, Home/Away Corners, Corners 1st Half, Total Corners
  },
  {
    id: "cards",
    betIds: [86, 43, 44, 46, 42],
    // Cards European Handicap, Cards O/U, Home/Away Cards, First Card
  },
  {
    id: "odd_even",
    betIds: [21, 22, 63, 52, 53],
    // Odd/Even, Odd/Even 1st/2nd Half, Home/Away Odd/Even
  },
  {
    id: "players",
    betIds: [36, 34, 35, 37, 38, 39, 40],
    // Anytime/First/Last Scorer, Home/Away Scorers, Assists, Fouls
  },
];
