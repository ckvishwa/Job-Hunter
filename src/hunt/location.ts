export type WorkArrangement = "remote" | "hybrid" | "onsite" | "unknown";

export interface ParsedLocation {
  raw: string;
  city: string | null;
  state: string | null;
  country: string | null;
  workArrangement: WorkArrangement;
  // false = city/state/country all unknown. Never conflated with workArrangement -- a job can
  // be workArrangement "remote" with locationKnown false (remote, no stated country) at the
  // same time. Unknown location must stay explicit, never silently become "Remote."
  locationKnown: boolean;
}

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
]);

// Description-derived remote phrases are intentionally strict -- a JD's benefits boilerplate
// ("we offer remote work options for some roles") must not false-positive an arrangement for a
// job whose actual location field states a real onsite/hybrid city.
const DESCRIPTION_REMOTE_PHRASES = [
  "fully remote",
  "100% remote",
  "remote-first",
  "remote position",
  "this role is remote",
  "this is a remote role",
];

function detectWorkArrangement(raw: string, descriptionText?: string | null): WorkArrangement {
  const rawLower = raw.toLowerCase();
  if (/\bremote\b/.test(rawLower)) return "remote";
  if (/\bhybrid\b/.test(rawLower)) return "hybrid";
  if (/\bonsite\b|\bon-site\b/.test(rawLower)) return "onsite";
  if (descriptionText) {
    const descLower = descriptionText.toLowerCase();
    if (DESCRIPTION_REMOTE_PHRASES.some((phrase) => descLower.includes(phrase))) return "remote";
  }
  return "unknown";
}

function resolveCountryToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (/^(us|usa|u\.s\.a?\.?|united states)$/i.test(trimmed)) return "United States";
  return trimmed;
}

export function parseLocation(raw: string | null | undefined, descriptionText?: string | null): ParsedLocation {
  const rawStr = raw ?? "";
  const workArrangement = detectWorkArrangement(rawStr, descriptionText);

  if (!rawStr.trim()) {
    return { raw: rawStr, city: null, state: null, country: null, workArrangement, locationKnown: false };
  }

  // Strip a trailing "(Hybrid)"/"(Onsite)"/"(Remote)" arrangement tag before parsing
  // city/state/country -- it's already been consumed by detectWorkArrangement above.
  const cleaned = rawStr.replace(/\s*\([^()]*\)\s*$/, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);

  let city: string | null = null;
  let state: string | null = null;
  let country: string | null = null;

  if (parts.length === 1) {
    const remoteMatch = parts[0]!.match(/^remote\b[\s\-–,]*(.*)$/i);
    if (remoteMatch) {
      country = resolveCountryToken(remoteMatch[1] ?? "");
    }
    // A single bare token that isn't a "Remote ..." marker (e.g. a lone city name with no
    // state/country) can't be reliably split into city vs. country -- left unknown rather than
    // guessed.
  } else if (parts.length >= 2) {
    const first = parts[0]!;
    const second = parts[1]!;
    if (/^remote$/i.test(first)) {
      country = resolveCountryToken(second);
    } else {
      city = first;
      const stateCandidate = second.toUpperCase();
      if (US_STATE_CODES.has(stateCandidate)) {
        state = stateCandidate;
        country = "United States";
      } else {
        country = resolveCountryToken(second);
      }
    }
  }

  const locationKnown = city !== null || state !== null || country !== null;
  return { raw: rawStr, city, state, country, workArrangement, locationKnown };
}
