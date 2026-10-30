/** Public-address and scheme checks for untrusted job-source URLs. Fixture servers opt in with allowLoopback. */

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata"]);

export function isBlockedIp(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  const parts = v4.slice(1).map(Number);
  if (parts.length !== 4 || parts.some((part) => part > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function assertFetchableUrl(value: string, options: { allowLoopback?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL is not absolute.");
  }
  if (url.username || url.password) throw new Error("URL must not carry credentials.");
  if (url.protocol !== "https:" && !(options.allowLoopback && url.protocol === "http:")) {
    throw new Error("Untrusted job sources must use HTTPS.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!options.allowLoopback && (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal") || isBlockedIp(host))) {
    throw new Error(`Blocked host ${host}.`);
  }
  return url;
}

export async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Response exceeded the size cap.");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Response exceeded the size cap.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
