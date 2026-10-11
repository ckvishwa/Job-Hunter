import { closePersistentChrome, launchPersistentChrome } from "../../../src/browser/launcher.js";
import { closeManagedChrome, launchManagedChrome } from "../../../src/browser/managed.js";

// ORBITAL_LEGACY=1 uses the pre-S4B launcher (no session restore) so the test can prove the root cause of the lost logins.
const legacy = process.env.ORBITAL_LEGACY === "1";

// Child process for the persistence proof: opens the managed headed Chrome on <profile>, visits <url>, waits for the page to say it is done, optionally HOLDS
// the profile open until stdin closes, then closes cleanly. Prints one JSON line. Never prints cookie values.
const [profile, url, hold] = process.argv.slice(2) as [string, string, string | undefined];
try {
  const context = await (legacy ? launchPersistentChrome : launchManagedChrome)(profile, { headless: false, args: ["--no-first-run", "--disable-background-networking", "--disable-component-update"] });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: "load" });
  let clicked = false;
  if ((await page.title()) === "login") {
    // the visible sign-in page: the "user" signs in themselves (a click on the fixture's button); nothing is typed or bypassed
    clicked = true;
    await page.click("#go");
  }
  await page.waitForFunction("document.title === 'done'", undefined, { timeout: 15_000 }).catch(() => undefined);
  console.log(JSON.stringify({ event: "opened", pid: process.pid, title: await page.title(), clicked }));
  if (hold === "hold") await new Promise<void>((resolve) => { process.stdin.on("end", resolve); process.stdin.resume(); });
  await (legacy ? closePersistentChrome : closeManagedChrome)(context, profile);
  console.log(JSON.stringify({ event: "closed" }));
} catch (error) {
  console.log(JSON.stringify({ event: "error", code: (error as { code?: string }).code ?? null, name: (error as Error).name }));
  process.exitCode = 3;
}
