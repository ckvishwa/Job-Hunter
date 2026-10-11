// Thin client for the TypeScript API. The browser never talks to the database or the AI service.
import { ApiError, classifyNetworkFailure, classifyResponse } from "./errors";

export interface FactView {
  factId: string;
  kind: string;
  value: string;
  polarity: "has" | "lacks";
  attributes: Record<string, unknown>;
  source: { kind: string; reference: string; locator?: string };
  span: { start: number; end: number; quote: string } | null;
  proposedBy: "rules" | "qwen" | "user";
  approvalStatus: "pending" | "approved" | "rejected";
  sensitivity: "normal" | "sensitive";
  verification: { verifiedBy: string | null; verifiedAt: string | null };
  contentDigest: string;
  headRevision: number;
  notes: string | null;
}

export { ApiError } from "./errors";

let csrfToken = "";
const REQUEST_TIMEOUT_MS = 12_000;
const UPLOAD_TIMEOUT_MS = 60_000;

async function call<T>(method: string, url: string, body?: BodyInit, json = false, readAttempts = 2): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-csrf-token"] = csrfToken;
  if (json) headers["content-type"] = "application/json";
  // Idempotent reads survive one transient proxy/connection hiccup; writes are never retried automatically.
  const attempts = method === "GET" ? readAttempts : 1;
  let failure: ApiError | undefined;
  for (let i = 0; i < attempts; i += 1) {
    let res: Response;
    try {
      // A stalled connection (the dev proxy waiting on a dead or half-open API) must end in a visible error, never an endless spinner.
      res = await fetch(url, { method, headers, body, credentials: "same-origin", signal: AbortSignal.timeout(body instanceof FormData ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS) });
    } catch {
      failure = classifyNetworkFailure(navigator.onLine);
      if (failure.kind === "offline") break; // retrying while offline only delays the message
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const payload: unknown = await res.json().catch(() => null);
    if (res.ok) return (payload ?? {}) as T;
    failure = classifyResponse({ status: res.status, json: payload });
    if (failure.status === 502 || failure.status === 503 || failure.status === 504) {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    break;
  }
  throw failure ?? new ApiError(0, "API_UNAVAILABLE", "The Job Hunter API is not reachable.", "unavailable");
}

export const api = {
  get: <T>(url: string, options: { attempts?: number } = {}) => call<T>("GET", url, undefined, false, options.attempts ?? 2),
  post: <T>(url: string, data: unknown) => call<T>("POST", url, JSON.stringify(data), true),
  upload: <T>(url: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<T>("POST", url, form);
  },
};

export interface SessionInfo {
  authenticated: boolean;
  handle?: string;
}

/** One GET /api/v1/session. Throws a typed ApiError if the API cannot be reached; callers go through lib/session.ts. */
export async function fetchSession(): Promise<SessionInfo> {
  // One attempt only: a dead API must cost exactly one session request per check, not a retry burst.
  const s = await api.get<{ authenticated: boolean; csrfToken?: string; user?: { handle: string } }>("/api/v1/session", { attempts: 1 });
  if (s.authenticated && s.csrfToken) csrfToken = s.csrfToken;
  return { authenticated: s.authenticated === true, handle: s.user?.handle };
}

export async function signIn(accessToken: string): Promise<void> {
  const s = await call<{ csrfToken: string }>("POST", "/api/v1/session", JSON.stringify({ accessToken }), true);
  csrfToken = s.csrfToken;
}

export async function signOut(): Promise<void> {
  await call("DELETE", "/api/v1/session");
  csrfToken = "";
}
