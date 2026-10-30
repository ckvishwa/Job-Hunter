// Deterministic location classification for discovered postings. The policy is deliberately
// asymmetric: only a location that is clearly outside the US is dropped. Anything unknown or
// ambiguous stays visible and is flagged, so a missing or odd location string never hides a job.
// Every US posting is kept, whether on-site, hybrid or remote and in any state.

export type LocationVerdict =
  | "US" // a US location: any state, on-site, hybrid or remote
  | "NON_US" // clearly outside the US: dropped by discovery
  | "UNKNOWN"; // empty, bare "Remote"/"Hybrid", city-only, or otherwise ambiguous: kept, flagged

export type LocationFlag = "" | "LOCATION_UNKNOWN";

const STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", dc: "district of columbia",
  fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska",
  nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma",
  or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont",
  va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};
const TARGET_NAMES = ["connecticut", "new york", "massachusetts", "nyc", "new haven", "hartford", "stamford", "boston", "brooklyn", "manhattan", "cambridge, ma"];

// Clear non-US markers: countries, regions and major non-US cities. Matched on whole words.
const NON_US = [
  "canada", "toronto", "vancouver", "montreal", "ottawa", "calgary", "united kingdom", "uk", "england", "scotland", "wales", "london", "manchester", "ireland", "dublin",
  "germany", "berlin", "munich", "france", "paris", "spain", "madrid", "barcelona", "portugal", "lisbon", "italy", "milan", "netherlands", "amsterdam", "belgium", "switzerland",
  "zurich", "austria", "vienna", "poland", "warsaw", "krakow", "czech", "prague", "romania", "bucharest", "bulgaria", "sofia", "hungary", "budapest", "ukraine", "sweden",
  "stockholm", "norway", "oslo", "denmark", "copenhagen", "finland", "helsinki", "greece", "turkey", "istanbul", "israel", "tel aviv", "united arab emirates", "uae", "dubai",
  "india", "bangalore", "bengaluru", "hyderabad", "pune", "mumbai", "delhi", "gurgaon", "chennai", "singapore", "japan", "tokyo", "korea", "seoul", "china", "beijing", "shanghai",
  "hong kong", "taiwan", "taipei", "philippines", "manila", "vietnam", "thailand", "bangkok", "malaysia", "indonesia", "australia", "sydney", "melbourne", "new zealand", "auckland",
  "brazil", "sao paulo", "mexico", "mexico city", "argentina", "buenos aires", "colombia", "bogota", "chile", "santiago", "peru", "costa rica", "south africa", "nigeria", "kenya",
  "egypt", "emea", "apac", "latam", "europe", "european", "eu", "asia", "africa", "middle east", "anz", "dach",
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (terms: string[]) => new RegExp(`(?<![a-z0-9])(?:${terms.map(esc).join("|")})(?![a-z0-9])`);
const NON_US_RE = wordRe(NON_US);
const STATE_NAMES_RE = wordRe(Object.values(STATES));
const US_RE = /(?<![a-z0-9])(?:us|u\.s\.|u\.s\.a\.|usa|united states(?: of america)?)(?![a-z0-9])/;
const TARGET_NAME_RE = wordRe(TARGET_NAMES);

function segmentVerdict(raw: string): LocationVerdict {
  const text = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return "UNKNOWN";
  const remote = /(?<![a-z0-9])(?:remote|work from home|wfh|anywhere)(?![a-z0-9])/.test(text);
  const us = US_RE.test(text);
  // "Boston, MA" / "Hartford, CT": a two-letter state code only counts after a comma.
  const abbr = [...text.matchAll(/,\s*([a-z]{2})(?![a-z0-9])/g)].map((m) => m[1]!);
  const usPlace = abbr.some((a) => a in STATES) || TARGET_NAME_RE.test(text) || STATE_NAMES_RE.test(text);
  if (usPlace) return "US"; // "Boston, MA", "Austin, TX", "Washington, D.C.", "Remote - New York"
  if (us) return "US"; // "Remote - US", "United States", "US Remote", "Remote (USA)"
  if (NON_US_RE.test(text)) return "NON_US"; // "Remote - EMEA", "Toronto, Canada", "London"
  void remote;
  return "UNKNOWN"; // bare "Remote"/"Hybrid", a city with no region, ...
}

/** Verdict for a whole location field; several places separated by ; | / or " or " are judged together. */
export function classifyLocation(location: string | null | undefined): LocationVerdict {
  if (!location || !location.trim()) return "UNKNOWN";
  const segments = location.split(/\s*(?:;|\||\/|\bor\b)\s*/i).filter((s) => s.trim());
  const verdicts = segments.map(segmentVerdict);
  if (verdicts.includes("US")) return "US";
  if (verdicts.length > 0 && verdicts.every((v) => v === "NON_US")) return "NON_US";
  return "UNKNOWN";
}

export function locationFlag(location: string | null | undefined): LocationFlag {
  return classifyLocation(location) === "UNKNOWN" ? "LOCATION_UNKNOWN" : "";
}
