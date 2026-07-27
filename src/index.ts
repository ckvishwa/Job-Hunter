import path from "node:path";
import { loadRolesConfig, loadSitesConfig } from "./config/loader.js";
import { launchPersistentChrome } from "./browser/launcher.js";
import { pauseForVerification } from "./browser/verification.js";

const CONFIG_DIR = path.resolve("config");

async function main(): Promise<void> {
  const sites = loadSitesConfig(path.join(CONFIG_DIR, "sites.yml"));
  const roles = loadRolesConfig(path.join(CONFIG_DIR, "roles.yml"));

  console.log(`Loaded ${sites.length} site(s), ${roles.length} role group(s).`);

  const enabledSite = sites.find((site) => site.enabled);
  if (!enabledSite) {
    console.log("No enabled sites in config/sites.yml — nothing to do yet. (Phase 1: wiring only.)");
    return;
  }

  const context = await launchPersistentChrome();
  const page = await context.newPage();

  console.log(`Navigating to ${enabledSite.name} (${enabledSite.url})...`);
  await page.goto(enabledSite.url, { waitUntil: "domcontentloaded" });

  const verification = await pauseForVerification(page);
  if (verification.detected) {
    console.log(`Resumed after verification: ${verification.reason}`);
  } else {
    console.log("No verification detected.");
  }

  console.log("Phase 1 wiring demo complete. Browser context left open for manual inspection.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
