import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";

export interface SourceCoverageEntry {
  id: string;
  layer: "official-board-api" | "company-careers" | "portal-search" | "collect-adapter";
  implemented: boolean;
  enabled: boolean;
  verifiedThisRun: boolean;
  note: string;
}

interface PortalEntry {
  id?: string;
  type?: string;
  enabled?: boolean;
}

/** What the code can read today. Disabled portals stay disabled; this inventory does not turn them on. */
export function sourceCoverage(portalsYaml: string): { sources: SourceCoverageEntry[]; verifiedLiveThisRun: number } {
  const parsed = parseYaml(portalsYaml) as { portals?: PortalEntry[] };
  const portals = parsed.portals ?? [];
  const portalEntries: SourceCoverageEntry[] = portals.map((portal) => ({
    id: portal.id ?? portal.type ?? "unknown",
    layer: "portal-search",
    implemented: true,
    enabled: portal.enabled === true,
    verifiedThisRun: false,
    note: portal.enabled === true
      ? "Enabled in portals.yml. This audit did not run a live search against it."
      : "Ships disabled. A live portal search was not run, and the entry was not enabled.",
  }));
  const sources: SourceCoverageEntry[] = [
    {
      id: "greenhouse",
      layer: "official-board-api",
      implemented: true,
      enabled: true,
      verifiedThisRun: false,
      note: "S3 discovery reads the public Greenhouse board API. The isolated M4 catalog currently has no stored jobs.",
    },
    {
      id: "lever",
      layer: "official-board-api",
      implemented: true,
      enabled: true,
      verifiedThisRun: false,
      note: "S3 discovery reads the public Lever postings API. The isolated M4 catalog currently has no stored jobs.",
    },
    {
      id: "company-careers",
      layer: "company-careers",
      implemented: true,
      enabled: true,
      verifiedThisRun: false,
      note: "Registry-backed Greenhouse, Lever, Workday, and generic company pages. A company is skipped when its verified ATS fields are missing. No live registry crawl was run for this audit.",
    },
    {
      id: "workday",
      layer: "collect-adapter",
      implemented: true,
      enabled: true,
      verifiedThisRun: false,
      note: "Present on the company-careers and collect paths. It is not a second S3 board type. The jobs table still accepts greenhouse and lever identities only.",
    },
    {
      id: "generic-playwright",
      layer: "collect-adapter",
      implemented: true,
      enabled: false,
      verifiedThisRun: false,
      note: "Selector-driven company pages. Placeholder portal selectors are not enabled.",
    },
    ...portalEntries,
  ];
  return { sources, verifiedLiveThisRun: sources.filter((source) => source.verifiedThisRun).length };
}

export function sourceCoverageFromFile(filePath: string): { sources: SourceCoverageEntry[]; verifiedLiveThisRun: number } {
  return sourceCoverage(readFileSync(filePath, "utf8"));
}
