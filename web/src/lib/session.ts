import { ApiError, type FailureKind } from "./errors";
import { fetchSession } from "./api";

// One place that answers "can this page show private data?". A failed session fetch is always one of these states, never an
// exception that aborts the page script (which is what used to leave the application blank).

export type SessionState =
  | { status: "ready"; handle: string | undefined }
  | { status: "signed-out" }
  | { status: "expired" }
  | { status: "unavailable"; detail: string }
  | { status: "offline" }
  | { status: "error"; code: string; message: string };

const FLAG = "jh_was_authenticated";

function readFlag(): boolean {
  try {
    return sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}
function writeFlag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(FLAG, "1");
    else sessionStorage.removeItem(FLAG);
  } catch { /* storage blocked: expired and signed-out then look the same, which is safe */ }
}

export const markSignedIn = (): void => writeFlag(true);
export const markSignedOut = (): void => writeFlag(false);

/** Maps a thrown error to the session state it implies. Anything that is not a typed ApiError is an unexpected error. */
export function stateForFailure(error: unknown): SessionState {
  if (!(error instanceof ApiError)) return { status: "error", code: "UNEXPECTED", message: "Something unexpected went wrong." };
  const kind: FailureKind = error.kind;
  if (kind === "unauthenticated") return readFlag() ? { status: "expired" } : { status: "signed-out" };
  if (kind === "offline") return { status: "offline" };
  if (kind === "unavailable") return { status: "unavailable", detail: error.message };
  return { status: "error", code: error.code, message: error.message };
}

let inflight: Promise<SessionState> | null = null;

/** Never rejects. Concurrent callers share one request; the result is not cached, so a Retry always asks the server again. */
export function checkSession(): Promise<SessionState> {
  if (inflight) return inflight;
  inflight = (async (): Promise<SessionState> => {
    try {
      const s = await fetchSession();
      if (s.authenticated) {
        markSignedIn();
        return { status: "ready", handle: s.handle };
      }
      return readFlag() ? { status: "expired" } : { status: "signed-out" };
    } catch (error) {
      return stateForFailure(error);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
