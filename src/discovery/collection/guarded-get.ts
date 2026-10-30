import { assertFetchableUrl, readBounded } from "../security/url-guard.js";

export interface GuardedResponse {
  status: number;
  finalUrl: string;
  body: string;
  hops: string[];
  error?: string;
}

export interface GuardedGetOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
}

function resolveRedirect(current: string, location: string): string {
  return new URL(location, current).toString();
}

/** HTTPS fetch with a timeout, a size cap, and a check of every redirect target before it is followed. */
export async function guardedGet(input: string, options: GuardedGetOptions = {}): Promise<GuardedResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const hops: string[] = [];
  let current: string;
  try {
    current = assertFetchableUrl(input).toString();
  } catch (error) {
    return { status: 0, finalUrl: input, body: "", hops, error: error instanceof Error ? error.message : "URL rejected" };
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    hops.push(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: options.accept ?? "text/html,application/json;q=0.9,*/*;q=0.1" },
      });
      const location = response.headers.get("location");
      if (location && response.status >= 300 && response.status < 400) {
        if (hop === maxRedirects) {
          return { status: response.status, finalUrl: current, body: "", hops, error: "Redirect limit reached." };
        }
        try {
          current = assertFetchableUrl(resolveRedirect(current, location)).toString();
        } catch (error) {
          return { status: 0, finalUrl: current, body: "", hops, error: error instanceof Error ? error.message : "Redirect rejected" };
        }
        continue;
      }
      const body = await readBounded(response, maxBytes);
      return { status: response.status, finalUrl: response.url || current, body, hops };
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      return { status: 0, finalUrl: current, body: "", hops, error: controller.signal.aborted ? `Timed out after ${timeoutMs}ms` : message };
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 0, finalUrl: current, body: "", hops, error: "Redirect limit reached." };
}
