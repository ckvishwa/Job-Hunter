import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { SESSION_STATE_FILE } from "./session-state.js";
import { ProfileInUseError, acquireManagedBrowser, describeProfile, resolveBrowserProfileDir } from "./managed.js";

// npm run browser:status            where the managed profile is, whether another process owns it, and a count (never values) of saved session cookies
// npm run browser:login -- [--url https://...]   open the managed headed Chrome so YOU can sign in; close the window or press Enter when done.
// Orbital never types credentials, never bypasses MFA/CAPTCHA/employer verification, and never touches your everyday Chrome profile.

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { url: { type: "string" }, profile: { type: "string" } } });
const dir = values.profile ? path.resolve(values.profile) : resolveBrowserProfileDir();

async function main(): Promise<number> {
  if (command === "status") {
    const d = describeProfile(dir);
    let session: { savedAt: string; sessionCookies: number; domains: number } | null = null;
    const file = path.join(dir, SESSION_STATE_FILE);
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, "utf8")) as { savedAt: string; cookies: Array<{ domain: string }> };
        session = { savedAt: s.savedAt, sessionCookies: s.cookies.length, domains: new Set(s.cookies.map((c) => c.domain)).size };
      } catch { /* unreadable */ }
    }
    console.log(JSON.stringify({ profileDir: d.dir, exists: d.exists, owner: d.owner, savedSessionState: session, note: "counts only; cookie names and values are never printed" }, null, 2));
    return 0;
  }
  if (command === "login") {
    let handle;
    try {
      handle = await acquireManagedBrowser({ profileDir: dir });
    } catch (error) {
      if (error instanceof ProfileInUseError) {
        console.error(error.message);
        return 2;
      }
      throw error;
    }
    try {
      const page = handle.context.pages()[0] ?? (await handle.context.newPage());
      if (values.url) await page.goto(values.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      console.log(`Managed Chrome is open (profile ${handle.profileDir}). Sign in yourself, then close the window or press Enter here.`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await Promise.race([rl.question(""), new Promise<void>((resolve) => handle.context.on("close", () => resolve()))]);
      rl.close();
    } finally {
      await handle.release();
    }
    console.log("Closed. Cookies, localStorage and IndexedDB stay in the profile; session cookies were saved for the next launch.");
    return 0;
  }
  console.error("usage: browser status | browser login [--url <url>] [--profile <dir>]");
  return 2;
}

process.exitCode = await main().catch((e) => {
  console.error(`browser ${command} failed: ${e instanceof Error ? e.message : String(e)}`);
  return 1;
});
