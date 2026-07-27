import type { SiteConfig } from "../types.js";
import type { SourceAdapter } from "./types.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { workdayAdapter } from "./workday.js";
import { createGenericPlaywrightAdapter, type GenericPlaywrightDeps } from "./generic-playwright.js";

const STATIC_ADAPTERS: SourceAdapter[] = [greenhouseAdapter, leverAdapter, workdayAdapter];

export function resolveAdapter(site: SiteConfig, genericDeps?: GenericPlaywrightDeps): SourceAdapter {
  for (const adapter of STATIC_ADAPTERS) {
    if (adapter.canHandle(site)) return adapter;
  }
  if (site.adapter === "generic") {
    if (!genericDeps) {
      throw new Error(`Site "${site.id}" requires a browser context for the generic adapter`);
    }
    return createGenericPlaywrightAdapter(genericDeps);
  }
  throw new Error(`No adapter can handle site "${site.id}" (adapter: ${site.adapter})`);
}
