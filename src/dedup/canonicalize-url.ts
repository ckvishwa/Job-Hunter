import { createHash } from "node:crypto";

const TRACKING_PARAMS_EXACT = new Set(["gh_src", "lever-source", "ref", "trk"]);

export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  const params = url.searchParams;
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS_EXACT.has(lower)) {
      params.delete(key);
    }
  }
  params.sort();
  const query = params.toString();
  url.search = query ? `?${query}` : "";

  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;

  return url.toString();
}

export function computeJobId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalizeUrl(canonicalUrl)).digest("hex").slice(0, 16);
}
