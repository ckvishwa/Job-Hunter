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
