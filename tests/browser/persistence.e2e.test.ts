import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_LOCK_FILE, ProfileInUseError, acquireOwnerLock, resolveBrowserProfileDir } from "../../src/browser/managed.js";
import { SESSION_STATE_FILE } from "../../src/browser/session-state.js";

// BROWSER-PERSISTENCE proof: two completely separate OS processes, each launching real headed Chrome on the SAME isolated temporary profile, against a
// loopback fixture site. Nothing here touches the real automation profile or the user's everyday Chrome profile.

let server: http.Server;
let base = "";
let revoked = false;
const reports: Array<Record<string, unknown>> = [];
const work = mkdtempSync(path.join(os.tmpdir(), "orbital-persist-"));
const realDefault = resolveBrowserProfileDir({});
const realDefaultBefore = existsSync(realDefault) ? readdirSync(realDefault).sort().join(",") : null;


beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = req.headers.cookie ?? "";
    if (url.pathname === "/set") {
      res.setHeader("Set-Cookie", ["persist_cookie=P1; Max-Age=86400; Path=/", "session_cookie=S1; Path=/", "expired_cookie=E1; Max-Age=0; Path=/"]);
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>pending</title><script>
        localStorage.setItem("ls_key","LS1");
        const open = indexedDB.open("orbital", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("kv");
        open.onsuccess = () => { const tx = open.result.transaction("kv","readwrite"); tx.objectStore("kv").put("IDB1","k"); tx.oncomplete = () => { document.title = "done"; }; };
      </script>`);
      return;
    }
    if (url.pathname === "/read") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>pending</title><script>
        (async () => {
          const idb = await new Promise((resolve) => { const o = indexedDB.open("orbital", 1); o.onupgradeneeded = () => { o.result.createObjectStore("kv"); }; o.onsuccess = () => { const g = o.result.transaction("kv").objectStore("kv").get("k"); g.onsuccess = () => resolve(g.result ?? null); g.onerror = () => resolve(null); }; o.onerror = () => resolve(null); });
          await fetch("/report", { method: "POST", body: JSON.stringify({ tag: new URLSearchParams(location.search).get("tag"), ls: localStorage.getItem("ls_key"), idb, jsCookie: document.cookie }) });
          document.title = "done";
        })();
      </script>`);
      return;
    }
    if (url.pathname === "/report") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        reports.push({ ...JSON.parse(body), serverSawCookieHeader: cookie });
        res.end("ok");
      });
      return;
    }
    // an app whose session can be revoked: needs session_cookie=S1 unless the user logs in again
    if (url.pathname === "/app") {
      res.setHeader("content-type", "text/html");
      const signedIn = /session_cookie=S1\b/.test(cookie) && !revoked;
      res.end(`<!doctype html><title>${signedIn ? "done" : "login"}</title><body>${signedIn ? "signed in" : `<form method="post" action="/login"><button id="go">Sign in</button></form>`}</body>`);
      return;
    }
    if (url.pathname === "/login") {
      revoked = false;
      res.setHeader("Set-Cookie", "session_cookie=S1; Path=/");
      res.statusCode = 302;
      res.setHeader("Location", "/app");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
});

interface Child { events: Array<Record<string, unknown>>; exit: Promise<number | null>; stop: () => void }
function child(profile: string, pathAndQuery: string, hold = false, legacy = false): Child {
  const p = spawn(process.execPath, ["--import", "tsx", "tests/browser/helpers/child.ts", profile, `${base}${pathAndQuery}`, ...(hold ? ["hold"] : [])], { cwd: process.cwd(), stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ORBITAL_LEGACY: legacy ? "1" : "0" } });
  const events: Array<Record<string, unknown>> = [];
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      try { events.push(JSON.parse(buf.slice(0, i))); } catch { /* not ours */ }
      buf = buf.slice(i + 1);
    }
  });
  return { events, exit: new Promise((resolve) => p.on("exit", (code) => resolve(code))), stop: () => p.stdin.end() };
}
const waitFor = async (c: Child, event: string, ms = 60_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (c.events.some((e) => e.event === event)) return;
    if (c.events.some((e) => e.event === "error")) throw new Error(`child error: ${JSON.stringify(c.events)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${event}`);
};
const run = async (profile: string, p: string): Promise<Child> => { const c = child(profile, p); await c.exit; return c; };

describe("BROWSER-PERSISTENCE (real headed Chrome, two separate processes)", { timeout: 180_000 }, () => {
  const profileA = path.join(work, "profile-a");
  const profileB = path.join(work, "profile-b");

  it("a second, completely new process on the same profile sees the cookie, session cookie, localStorage and IndexedDB set by the first", async () => {
    const first = await run(profileA, "/set");
    expect(first.events.map((e) => e.event)).toEqual(["opened", "closed"]);
    expect(existsSync(profileA)).toBe(true); // normal cleanup keeps the profile
    expect(existsSync(path.join(profileA, "Default"))).toBe(true);
    expect(existsSync(path.join(profileA, OWNER_LOCK_FILE))).toBe(false); // owner lock released on close
    expect(existsSync(path.join(profileA, SESSION_STATE_FILE))).toBe(true);

    const second = await run(profileA, "/read?tag=A2");
    expect(second.events.map((e) => e.event)).toEqual(["opened", "closed"]);
    const seen = reports.find((r) => r.tag === "A2")!;
    expect(seen.ls).toBe("LS1");
    expect(seen.idb).toBe("IDB1");
    expect(String(seen.serverSawCookieHeader)).toContain("persist_cookie=P1");
    expect(String(seen.serverSawCookieHeader)).toContain("session_cookie=S1"); // a SESSION cookie: Chrome alone would have dropped it
    expect(String(seen.serverSawCookieHeader)).not.toContain("expired_cookie");
  });

  it("root cause: a plain persistent Chrome profile keeps persistent cookies, localStorage and IndexedDB but DROPS session cookies on restart", async () => {
    const legacyProfile = path.join(work, "profile-legacy");
    const a = child(legacyProfile, "/set", false, true);
    await a.exit;
    const b = child(legacyProfile, "/read?tag=LEGACY", false, true);
    await b.exit;
    const seen = reports.find((r) => r.tag === "LEGACY")!;
    expect(seen.ls).toBe("LS1");
    expect(String(seen.serverSawCookieHeader)).toContain("persist_cookie=P1");
    expect(String(seen.serverSawCookieHeader)).not.toContain("session_cookie"); // this is what logged you out on every restart
  });

  it("another isolated profile cannot read any of it", async () => {
    await run(profileB, "/read?tag=B1");
    const seen = reports.find((r) => r.tag === "B1")!;
    expect(seen.ls).toBeNull();
    expect(seen.idb).toBeNull();
    expect(String(seen.serverSawCookieHeader)).toBe("");
  });

  it("only one process can own a profile: a second owner gets PROFILE_IN_USE, and nobody's Chrome is killed", async () => {
    const holder = child(profileA, "/set", true);
    try {
      await waitFor(holder, "opened");
      expect(() => acquireOwnerLock(profileA)).toThrowError(ProfileInUseError); // in-process attempt while another process owns it
      const rival = child(profileA, "/read?tag=RIVAL");
      await rival.exit;
      expect(rival.events).toEqual([{ event: "error", code: "PROFILE_IN_USE", name: "ProfileInUseError" }]);
      // the holder is still alive and its browser still works
      expect(holder.events.some((e) => e.event === "closed")).toBe(false);
    } finally {
      holder.stop();
      await holder.exit;
    }
    expect(holder.events.map((e) => e.event)).toEqual(["opened", "closed"]);
    expect(existsSync(path.join(profileA, OWNER_LOCK_FILE))).toBe(false);
    expect(reports.some((r) => r.tag === "RIVAL")).toBe(false);
  });

  it("a stale lock left by a crashed owner is reclaimed; a live owner is not", () => {
    const dir = path.join(work, "profile-stale");
    const a = acquireOwnerLock(dir, () => true);
    expect(() => acquireOwnerLock(dir, () => true)).toThrowError(/PROFILE_IN_USE/);
    writeFileSync(path.join(dir, OWNER_LOCK_FILE), JSON.stringify({ pid: 999999, token: "dead", host: "x", startedAt: "2020-01-01T00:00:00Z" }));
    const b = acquireOwnerLock(dir, (pid) => pid !== 999999);
    b.release();
    a.release();
    expect(existsSync(path.join(dir, OWNER_LOCK_FILE))).toBe(false);
  });

  it("expired session state is not restored, and a revoked session is handled by signing in again, which is then remembered", async () => {
    // 1. a saved session older than the TTL is ignored (the server then sees no session)
    const stateFile = path.join(profileB, SESSION_STATE_FILE);
    await run(profileB, "/set");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.savedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(stateFile, JSON.stringify(state));
    await run(profileB, "/read?tag=B2");
    expect(String(reports.find((r) => r.tag === "B2")!.serverSawCookieHeader)).not.toContain("session_cookie");
    // 2. the session is revoked server-side: the app shows the sign-in page; the user signs in through the visible browser and the new session sticks
    await run(profileB, "/set"); // fresh session cookie in this profile
    const ok = await run(profileB, "/app");
    expect(ok.events[0]).toMatchObject({ title: "done", clicked: false }); // restored session works, no sign-in needed
    revoked = true;
    const relogin = await run(profileB, "/app");
    expect(relogin.events[0]).toMatchObject({ clicked: true, title: "done" }); // revoked: visible sign-in page, user signs in
    revoked = false;
    const remembered = await run(profileB, "/app");
    expect(remembered.events[0]).toMatchObject({ title: "done", clicked: false }); // the NEW session was preserved
  });

  it("never touched the real automation profile", () => {
    const after = existsSync(realDefault) ? readdirSync(realDefault).sort().join(",") : null;
    expect(after).toBe(realDefaultBefore);
    expect(statSync(work).isDirectory()).toBe(true);
  });
});
