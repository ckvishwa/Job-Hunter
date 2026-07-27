import { z } from "zod";
import { ADAPTERS, PROFILES } from "../types.js";

export const siteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  adapter: z.enum(ADAPTERS),
  enabled: z.boolean(),
});

export const sitesFileSchema = z.object({
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
