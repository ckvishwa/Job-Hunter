// Pure classification of API failures, so every page reacts the same way and the rules can be unit tested without a browser.

export type FailureKind =
  /** The browser is offline, or the connection to the UI server itself failed. */
  | "offline"
  /** The UI server answered but the Job Hunter API behind it did not (connection refused, proxy error, 502/503/504). */
  | "unavailable"
  /** No valid session: never signed in, or the session cookie expired or was cleared. */
  | "unauthenticated"
  /** The API answered with an unexpected server error (HTTP 5xx with a JSON error body). */
  | "server"
  /** A normal, expected rejection (validation, conflict, not found, ...). Handled by the page that made the call. */
  | "client";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly kind: FailureKind = "client") {
    super(message);
    this.name = "ApiError";
  }
}

export interface RawResponse {
  status: number;
  /** Parsed JSON body, or null when the body was empty or not JSON (a proxy error page, for example). */
  json: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The API's own error shape: { error: { code, message } }. */
export function apiErrorBody(json: unknown): { code: string; message: string } | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  const { code, message } = json.error;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

/**
 * A failed HTTP response -> typed error.
 *  - A 5xx without the API's JSON error body did not come from the API (the dev proxy answers 500 with an empty or plain body when the
 *    API is down), so it is "unavailable", not a server bug.
 *  - A 502/503/504 is always "unavailable".
 *  - A 5xx WITH the API's JSON body is a genuine server error.
 *  - 401 is "unauthenticated".
 */
export function classifyResponse(res: RawResponse): ApiError {
  const body = apiErrorBody(res.json);
  if (res.status === 401) return new ApiError(401, body?.code ?? "UNAUTHENTICATED", body?.message ?? "Sign in first.", "unauthenticated");
  if ([502, 503, 504].includes(res.status) || (res.status >= 500 && !body)) {
    return new ApiError(res.status, "API_UNAVAILABLE", "The Job Hunter API is not reachable.", "unavailable");
  }
  if (res.status >= 500) return new ApiError(res.status, body?.code ?? "INTERNAL_ERROR", body?.message ?? "The server reported an unexpected error.", "server");
  return new ApiError(res.status, body?.code ?? "ERROR", body?.message ?? `Request failed (${res.status}).`, "client");
}

/** A fetch() that threw (no response at all). */
export function classifyNetworkFailure(online: boolean): ApiError {
  return online
    ? new ApiError(0, "API_UNAVAILABLE", "The Job Hunter API is not reachable.", "unavailable")
    : new ApiError(0, "OFFLINE", "This browser is offline.", "offline");
}

export const isRetryableTransport = (e: ApiError): boolean => e.kind === "unavailable" || e.kind === "offline";
