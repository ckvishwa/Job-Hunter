import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigValidationError, loadCompanyRegistry } from "./loader.js";
import type { CompanyRegistryEntry } from "./schema.js";
import { hostMatchesDomain, parseAtsPostingUrl } from "../domain/canonical-job.js";

// Minimal validated input for the visible-browser search flow (npm run search): which company,
// where its verified careers/search page is, what to type, and how many jobs to collect.
// Discovery only: candidate facts and application answers do not belong here.

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "careersUrl must be an https URL");

// Optional, observed-structure hints for pages whose markup the defaults do not cover. They are
// plain CSS/ARIA descriptions of what a person sees; none of them can name a script or a URL.
const selectorsSchema = z
  .object({
    // Accessible name of the visible search field (e.g. "Search for a role"). Default: any
    // searchbox / textbox / combobox whose name matches /search/i.
    searchBoxName: z.string().min(1).max(120).optional(),
    // CSS selector for anchors that open a posting from the results list.
    resultLink: z.string().min(1).max(200).default("a[href*='/jobs/'], a[href*='/job/'], a[href*='/careers/listing/'], a[href*='gh_jid']"),
    // Text that the page shows when nothing matches (case-insensitive regular expression source).
    emptyStateText: z.string().min(1).max(200).default("no (open )?(roles|jobs|results|positions) (match|found)|no matching"),
    // CSS selector of the container holding the rendered job description on a posting page.
    descriptionContainer: z.string().min(1).max(200).default("main, article, [role=main]"),
  })
  .strict()
  .default({});

export const searchTargetSchema = z
  .object({
    company: z.string().min(1).max(120),
    careersUrl: httpsUrl,
    queries: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
    maxJobs: z.number().int().min(1).max(25),
    // Registry file that holds this company's verified identity (corporate domain + ATS board).
    registry: z.string().min(1).default("config/fortune500-registry.json"),
    selectors: selectorsSchema,
  })
  .strict();
export type SearchTarget = z.infer<typeof searchTargetSchema>;

export const searchInputFileSchema = z
  .object({
    searches: z.array(searchTargetSchema).min(1).max(20),
  })
  .strict();
export type SearchInputFile = z.infer<typeof searchInputFileSchema>;

export interface ResolvedSearchTarget {
  target: SearchTarget;
  entry: CompanyRegistryEntry;
}

export function loadSearchInput(filePath: string): SearchInputFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigValidationError(filePath, `Could not read file: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigValidationError(filePath, `Could not parse JSON: ${(err as Error).message}`);
  }
  const result = searchInputFileSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
    throw new ConfigValidationError(filePath, details);
  }
  return result.data;
}

/**
 * Ties a search target to a registry employer BEFORE any browser opens: the company must exist,
 * and the careers URL host must be that employer's corporate domain (or its registered ATS board).
 * A careers URL on an unrelated host is rejected, so the demo can never drive an unverified site.
 */
export function resolveSearchTarget(target: SearchTarget, cwd: string = process.cwd()): ResolvedSearchTarget {
  const registryPath = path.resolve(cwd, target.registry);
  const registry = loadCompanyRegistry(registryPath);
  const entry = registry.find((c) => c.company.toLowerCase() === target.company.toLowerCase());
  if (!entry) {
    throw new ConfigValidationError(registryPath, `  - company "${target.company}" is not in the registry`);
  }
  const url = new URL(target.careersUrl);
  const onCorporateDomain = entry.corporateDomain !== null && hostMatchesDomain(url.hostname, entry.corporateDomain);
  const ats = parseAtsPostingUrl(target.careersUrl);
  const onRegisteredBoard =
    ats !== null && entry.atsTenantOrBoardId !== null && ats.ats === entry.atsType && ats.board?.toLowerCase() === entry.atsTenantOrBoardId.toLowerCase();
  if (!onCorporateDomain && !onRegisteredBoard) {
    throw new ConfigValidationError(
      registryPath,
      `  - careersUrl host "${url.hostname}" is neither ${entry.company}'s corporate domain nor its registered ATS board`,
    );
  }
  return { target, entry };
}
