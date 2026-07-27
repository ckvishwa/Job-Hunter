import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import type { ZodType } from "zod";
import { rolesFileSchema, sitesFileSchema } from "./schema.js";
import type { CollectSettings, RoleConfig, SiteConfig } from "../types.js";

export class ConfigValidationError extends Error {
  constructor(filePath: string, details: string) {
    super(`Invalid config at ${filePath}:\n${details}`);
    this.name = "ConfigValidationError";
  }
}

function parseAndValidate<T>(filePath: string, schema: ZodType<T>): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigValidationError(filePath, `Could not read file: ${(err as Error).message}`);
  }

  const data = parseYaml(raw);
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigValidationError(filePath, details);
  }
  return result.data;
}

export function loadSitesConfig(filePath: string): SiteConfig[] {
  return parseAndValidate(filePath, sitesFileSchema).sites;
}

export function loadRolesConfig(filePath: string): RoleConfig[] {
  return parseAndValidate(filePath, rolesFileSchema).roles;
}

export function loadCollectSettings(filePath: string): CollectSettings {
  const parsed = parseAndValidate(filePath, sitesFileSchema);
  return parsed.settings as CollectSettings;
}
