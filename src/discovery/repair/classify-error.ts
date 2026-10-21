export const SOURCE_OUTCOMES = [
  "NOT_FOUND",
  "ACCESS_DENIED",
  "METHOD_NOT_ALLOWED",
  "UNPROCESSABLE_RESPONSE",
  "TIMEOUT",
  "ABORTED",
  "DNS_ERROR",
  "RATE_LIMITED",
  "INVALID_SOURCE_CONFIG",
  "EMPTY_BOARD",
  "SUCCESS",
] as const;

export type SourceOutcome = (typeof SOURCE_OUTCOMES)[number];

export interface ClassifiedFailure {
  outcome: SourceOutcome;
  transient: boolean;
  httpStatus: number | null;
  detail: string;
}

const TRANSIENT = new Set<SourceOutcome>(["TIMEOUT", "ABORTED", "DNS_ERROR", "RATE_LIMITED"]);

function detailOf(message: string, body: string): string {
  const text = (body || message).replace(/\s+/g, " ").trim();
  return text.slice(0, 300) || "No error message.";
}

/** Classify a transport failure. HTTP 405 is a method rejection only when the body is not an access challenge. HTTP 422 is unprocessable until the body is inspected; it is not automatically bad directory data. */
export function classifyTransportFailure(input: { status?: number | null; code?: string | null; message?: string | null; body?: string | null }): ClassifiedFailure {
  const message = input.message ?? "";
  const body = input.body ?? "";
  const status = input.status ?? null;
  const code = input.code ?? "";
  const challenge = /human verification|captcha|cf-challenge|just a moment|attention required/i.test(body);
  if (code === "ABORT_ERR" || /aborted/i.test(message)) {
    return { outcome: "ABORTED", transient: true, httpStatus: status, detail: detailOf(message, body) };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(`${code} ${message}`)) {
    return { outcome: "DNS_ERROR", transient: true, httpStatus: status, detail: detailOf(message, body) };
  }
  if (code === "TIMEOUT" || /timed out|timeout/i.test(message)) {
    return { outcome: "TIMEOUT", transient: true, httpStatus: status, detail: detailOf(message, body) };
  }
  if (status === 404) return { outcome: "NOT_FOUND", transient: false, httpStatus: status, detail: detailOf(message, body) };
  if (status === 403 || (status === 405 && challenge) || (status === 401 && challenge)) {
    return { outcome: "ACCESS_DENIED", transient: false, httpStatus: status, detail: status === 405 ? "HTTP 405 body is an access challenge, not an Allow-header method rejection." : detailOf(message, body) };
  }
  if (status === 405) return { outcome: "METHOD_NOT_ALLOWED", transient: false, httpStatus: status, detail: detailOf(message, body) };
  if (status === 422) return { outcome: "UNPROCESSABLE_RESPONSE", transient: false, httpStatus: status, detail: detailOf(message, body) };
  if (status === 429) return { outcome: "RATE_LIMITED", transient: true, httpStatus: status, detail: detailOf(message, body) };
  return { outcome: "UNPROCESSABLE_RESPONSE", transient: TRANSIENT.has("UNPROCESSABLE_RESPONSE"), httpStatus: status, detail: detailOf(message, body) };
}

export function outcomeIsTransient(outcome: SourceOutcome): boolean {
  return TRANSIENT.has(outcome);
}
