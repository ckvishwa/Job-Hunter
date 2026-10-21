export interface JsonLdJob {
  title: string | null;
  url: string | null;
  description: string | null;
  location: string | null;
  datePosted: string | null;
  identifier: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jobType(value: unknown): boolean {
  if (typeof value === "string") return value === "JobPosting" || value.endsWith("/JobPosting");
  if (Array.isArray(value)) return value.some((entry) => jobType(entry));
  return false;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function locationOf(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return text(value);
  const address = asRecord(record.address);
  return text(address?.addressLocality) ?? text(address?.addressRegion) ?? text(record.name) ?? text(record.address);
}

function walk(value: unknown, out: JsonLdJob[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, out);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  if (jobType(record["@type"])) {
    const identifier = asRecord(record.identifier);
    out.push({
      title: text(record.title),
      url: text(record.url) ?? text(record.hiringOrganization && asRecord(record.hiringOrganization)?.sameAs),
      description: text(record.description),
      location: locationOf(record.jobLocation),
      datePosted: text(record.datePosted),
      identifier: text(identifier?.value) ?? text(record.identifier),
    });
  }
  if (Array.isArray(record["@graph"])) walk(record["@graph"], out);
}

/** JobPosting nodes from application/ld+json blocks. Malformed JSON is skipped. */
export function extractJsonLdJobs(html: string): JsonLdJob[] {
  const jobs: JsonLdJob[] = [];
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(match[1] ?? ""), jobs);
    } catch {
      // One broken block does not discard the rest of the page.
    }
  }
  return jobs;
}
