import { ApiError, signIn, signOut } from "./api";
import { checkSession, markSignedIn, markSignedOut, stateForFailure, type SessionState } from "./session";

// The session gate. Every page calls startPage(). The gate always shows something: a loading note, the page, a sign-in form, or a
// specific error with a Retry button. It owns the sign-in form, the sign-out button and the page's private content container (#app).
// Required markup lives in layouts/Base.astro: #gate, #gate-status, #gate-title, #gate-text, #gate-retry, #signin-panel,
// #signin-form, #token, #signin, #signin-msg, #signin-note, #app, #signout.

type GateView = "loading" | "unavailable" | "offline" | "error" | "ready" | "signed-out" | "expired";

const $id = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
};

const COPY: Record<"unavailable" | "offline" | "error", { title: string; text: (detail?: string) => string }> = {
  unavailable: {
    title: "Can't reach the Job Hunter API",
    text: () =>
      "The page loaded, but the API behind it did not answer. Nothing you saved is lost. Start the stack with `npm run dev:stack` (or check `npm run dev:stack:status`), then press Try again.",
  },
  offline: { title: "You appear to be offline", text: () => "This browser has no network connection. Reconnect, then press Try again." },
  error: { title: "The server reported an unexpected error", text: (detail) => `${detail ?? "Something went wrong."} This is not a sign-in problem. Press Try again; if it keeps happening, check the API log.` },
};

export interface PageOptions {
  /** Runs once the user is signed in. Throw an ApiError to hand control back to the gate (expired / unavailable / error). */
  load: () => Promise<void>;
}

let running = false;
let current: GateView = "loading";
let lastLoad: PageOptions["load"] | null = null;

function show(view: GateView, detail?: string, note?: string, loadingTitle = "Checking your session..."): void {
  current = view;
  const status = $id("gate-status");
  const signin = $id("signin-panel");
  const app = $id("app");
  const retry = $id("gate-retry") as HTMLButtonElement;
  status.dataset.state = view;
  app.hidden = view !== "ready";
  signin.hidden = view !== "signed-out" && view !== "expired";
  const statusVisible = view === "loading" || view === "unavailable" || view === "offline" || view === "error";
  status.hidden = !statusVisible;
  retry.hidden = !(view === "unavailable" || view === "offline" || view === "error");
  retry.disabled = false;
  $id("signout").hidden = view !== "ready";
  if (view === "loading") {
    $id("gate-title").textContent = loadingTitle;
    $id("gate-text").textContent = "";
  } else if (view === "unavailable" || view === "offline" || view === "error") {
    $id("gate-title").textContent = COPY[view].title;
    $id("gate-text").textContent = COPY[view].text(detail);
  }
  const noteEl = $id("signin-note");
  noteEl.textContent = view === "expired" ? "Your session expired. Sign in again to continue." : note ?? "";
  noteEl.hidden = !noteEl.textContent;
}

function showState(s: SessionState): void {
  switch (s.status) {
    case "ready": return show("ready");
    case "signed-out": return show("signed-out");
    case "expired": return show("expired");
    case "unavailable": return show("unavailable", s.detail);
    case "offline": return show("offline");
    case "error": return show("error", s.message);
  }
}

/** One pass: check the session, then load the page. Re-entrant calls while a pass is running are ignored (no duplicate requests). */
async function pass(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (current !== "ready") show("loading");
    if (!navigator.onLine) return show("offline");
    const session = await checkSession();
    if (session.status !== "ready") return showState(session);
    if (!lastLoad) return show("ready");
    show("loading", undefined, undefined, "Loading your data...");
    try {
      await lastLoad();
      show("ready");
    } catch (error) {
      const state = stateForFailure(error);
      // A failed data load must never leave a half-built page: hand it to the gate (sign in / retry).
      showState(state.status === "ready" ? { status: "error", code: "UNEXPECTED", message: "Something unexpected went wrong." } : state);
    }
  } catch {
    show("error", "Something unexpected went wrong.");
  } finally {
    running = false;
  }
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  $id("gate-retry").addEventListener("click", () => {
    ($id("gate-retry") as HTMLButtonElement).disabled = true;
    void pass();
  });
  $id("signin-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const input = $id("token") as HTMLInputElement;
      const msg = $id("signin-msg");
      const button = $id("signin") as HTMLButtonElement;
      button.disabled = true;
      msg.textContent = "";
      try {
        await signIn(input.value);
        input.value = "";
        markSignedIn();
        await pass();
      } catch (error) {
        const e = error instanceof ApiError ? error : null;
        msg.dataset.kind = "error";
        msg.textContent =
          e?.kind === "unavailable" ? "The API is not reachable, so sign-in could not be checked. Start the stack and try again."
          : e?.kind === "offline" ? "This browser is offline."
          : e ? e.message : "Sign-in failed.";
      } finally {
        button.disabled = false;
      }
    })();
  });
  $id("signout").addEventListener("click", () => {
    void (async () => {
      try { await signOut(); } catch { /* the cookie may already be gone; leave anyway */ }
      markSignedOut();
      window.location.assign("/dashboard");
    })();
  });
  // Coming back online is the one automatic re-check, and only from a failure state.
  window.addEventListener("online", () => {
    if (current === "offline" || current === "unavailable") void pass();
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    if (current === "ready") return; // a handler on the page already reported it; do not tear down a working page
    show("error", "Something unexpected went wrong.");
  });
}

export function startPage(options: PageOptions): void {
  lastLoad = options.load;
  wire();
  void pass();
}

/** Re-runs the page's own load (for a section-level Retry). Goes through the same single-flight guard. */
export async function reloadPage(): Promise<void> {
  await pass();
}

