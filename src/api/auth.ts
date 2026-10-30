import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Single-user local authentication. The user proves they hold the access token once, and receives a signed, expiring,
// HttpOnly SameSite=Strict cookie. Writes additionally need a CSRF token derived from that cookie and a trusted Origin.

export const SESSION_COOKIE = "jh_session";

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const hmac = (secret: string, data: string): string => createHmac("sha256", secret).update(data).digest("hex");

export interface SessionCodec {
  issue(): { cookie: string; csrfToken: string; maxAgeSeconds: number };
  verify(cookie: string | undefined): { csrfToken: string } | null;
}

export function createSessionCodec(secret: string, ttlSeconds: number, now: () => number = Date.now): SessionCodec {
  const csrfFor = (cookie: string): string => hmac(secret, `csrf.${cookie}`);
  return {
    issue() {
      const expires = Math.floor(now() / 1000) + ttlSeconds;
      const body = `v1.${expires}.${randomBytes(16).toString("hex")}`;
      const cookie = `${body}.${hmac(secret, body)}`;
      return { cookie, csrfToken: csrfFor(cookie), maxAgeSeconds: ttlSeconds };
    },
    verify(cookie) {
      if (!cookie) return null;
      const parts = cookie.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") return null;
      const body = parts.slice(0, 3).join(".");
      if (!safeEqual(parts[3]!, hmac(secret, body))) return null;
      const expires = Number(parts[1]);
      if (!Number.isInteger(expires) || expires * 1000 < now()) return null;
      return { csrfToken: csrfFor(cookie) };
    },
  };
}

/** Fixed-window limiter for the login endpoint (in memory; this is a single-process local app). */
export function createLoginLimiter(maxPerWindow = 8, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(key: string): boolean {
      const t = now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        hits.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= maxPerWindow;
    },
  };
}
