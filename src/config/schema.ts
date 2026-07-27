import { z } from "zod";
import { ADAPTERS, PROFILES } from "../types.js";

export const collectSettingsSchema = z
  .object({
    maxPagesPerSource: z.number().int().positive().default(100),
    maxJobsPerSource: z.number().int().positive().default(5000),
    navigationTimeoutMs: z.number().int().positive().default(30000),
    delayBetweenRequestsMs: z.number().int().nonnegative().default(500),
  })
  .default({});

export const workdaySiteSchema = z.object({
  hostname: z.string().min(1),
  tenant: z.string().min(1),
  site: z.string().min(1),
});

export const genericSelectorsSchema = z.object({
  searchInputSelector: z.string().min(1),
  searchButtonSelector: z.string().min(1),
  resultCardSelector: z.string().min(1),
  jobLinkSelector: z.string().min(1),
  nextButtonSelector: z.string().min(1).optional(),
  loadMoreSelector: z.string().min(1).optional(),
  titleSelector: z.string().min(1),
  locationSelector: z.string().min(1),
  descriptionSelector: z.string().min(1),
  applyLinkSelector: z.string().min(1).optional(),
});

export const siteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  adapter: z.enum(ADAPTERS),
  enabled: z.boolean(),
  greenhouse: z.object({ boardToken: z.string().min(1).optional() }).optional(),
  lever: z.object({ site: z.string().min(1).optional() }).optional(),
  workday: workdaySiteSchema.optional(),
  generic: genericSelectorsSchema.optional(),
});

export const sitesFileSchema = z.object({
  settings: collectSettingsSchema,
  sites: z.array(siteSchema).min(1),
});

export const roleSchema = z.object({
  id: z.string().min(1),
  profile: z.enum(PROFILES),
  keywords: z.array(z.string().min(1)).min(1),
});

export const rolesFileSchema = z.object({
  roles: z.array(roleSchema).min(1),
});

export type SitesFile = z.infer<typeof sitesFileSchema>;
export type RolesFile = z.infer<typeof rolesFileSchema>;

// Selector/limit field names are deliberately aligned with the existing
// `GenericPortalSelectors` interface in
// src/discovery/adapters/configurable-generic-portal.ts (companySelector,
// salarySelector, dateSelector, searchUrlTemplate, nextButtonSelector) so a
// later task can wire that adapter to this schema without a field-name
// mismatch. `jobLinkSelector` is optional here (unlike that interface) because
// the current google-jobs adapter constructs its result URL synthetically and
// has no link selector at all — this schema must not fabricate one just to
// satisfy a stricter type.
export const portalConfigSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["google-jobs", "indeed", "monster", "linkedin-public", "generic"]),
  enabled: z.boolean(),
  baseUrl: z.string().url(),
  keywordParam: z.string().min(1).optional(),
  locationParam: z.string().min(1).optional(),
  searchInputSelector: z.string().min(1).optional(),
  searchButtonSelector: z.string().min(1).optional(),
  locationInputSelector: z.string().min(1).optional(),
  resultCardSelector: z.string().min(1),
  jobLinkSelector: z.string().min(1).optional(),
  nextButtonSelector: z.string().min(1).optional(),
  loadMoreSelector: z.string().min(1).optional(),
  titleSelector: z.string().min(1),
  locationSelector: z.string().min(1),
  companySelector: z.string().min(1).optional(),
  salarySelector: z.string().min(1).optional(),
  dateSelector: z.string().min(1).optional(),
  searchUrlTemplate: z.string().min(1).optional(),
  maxPages: z.number().int().positive().default(10),
  maxDiscoveries: z.number().int().positive().default(500),
  navigationTimeoutMs: z.number().int().positive().default(30000),
  delayBetweenActionsMs: z.number().int().nonnegative().default(1000),
  supportedLocations: z.array(z.string().min(1)).optional(),
  postingAgeFilterDays: z.number().int().positive().optional(),
  requiresLogin: z.boolean().default(false),
  onVerification: z.enum(["pause", "skip"]).default("pause"),
});

export const portalsFileSchema = z.object({
  settings: collectSettingsSchema,
  portals: z.array(portalConfigSchema).min(1),
});

export type PortalConfig = z.infer<typeof portalConfigSchema>;
export type PortalsFile = z.infer<typeof portalsFileSchema>;

export const companyRegistryEntrySchema = z.object({
  company: z.string().min(1),
  fortuneRank: z.number().int().positive().nullable(),
  corporateDomain: z.string().min(1),
  careersUrl: z.string().url(),
  atsType: z.enum(["greenhouse", "lever", "workday", "generic"]),
  atsTenantOrBoardId: z.string().min(1).nullable(),
  // Required (not optional) so every entry states explicitly whether a
  // verified Workday site segment exists (a value) or doesn't (null) —
  // never silently absent. Only meaningful for atsType: "workday" entries;
  // present-and-null on all others for schema uniformity.
  atsWorkdaySite: z.string().min(1).nullable(),
  // Reuses the existing genericSelectorsSchema (SiteConfig.generic) — no new
  // selector shape. Absent = "not yet configured", never fabricated.
  genericSelectors: genericSelectorsSchema.optional(),
  verificationStatus: z.enum(["verified", "unverified", "blocked"]),
  lastVerifiedDate: z.string().nullable(),
});

export const companyRegistrySchema = z.array(companyRegistryEntrySchema).superRefine((entries, ctx) => {
  const rankSeen = new Map<number, number[]>();
  const domainSeen = new Map<string, number[]>();

  entries.forEach((entry, index) => {
    if (entry.fortuneRank !== null) {
      const indices = rankSeen.get(entry.fortuneRank) ?? [];
      indices.push(index);
      rankSeen.set(entry.fortuneRank, indices);
    }

    const domainKey = `${entry.company.toLowerCase()}::${entry.corporateDomain.toLowerCase()}`;
    const indices = domainSeen.get(domainKey) ?? [];
    indices.push(index);
    domainSeen.set(domainKey, indices);
  });

  for (const [rank, indices] of rankSeen) {
    if (indices.length > 1) {
      const names = indices.map((i) => entries[i]?.company).join(", ");
      for (const index of indices) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "fortuneRank"],
          message: `Duplicate fortuneRank ${rank} shared by: ${names}`,
        });
      }
    }
  }

  for (const [, indices] of domainSeen) {
    if (indices.length > 1) {
      const names = indices.map((i) => entries[i]?.company).join(", ");
      for (const index of indices) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "corporateDomain"],
          message: `Duplicate company+corporateDomain pair shared by: ${names}`,
        });
      }
    }
  }
});

export type CompanyRegistryEntry = z.infer<typeof companyRegistryEntrySchema>;

