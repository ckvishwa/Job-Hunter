import { createHash } from "node:crypto";

export function fingerprintDescription(descriptionText: string): string {
  const normalized = descriptionText.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}
