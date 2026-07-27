function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; backoffMs: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < opts.retries) {
        await sleep(opts.backoffMs * (attempt + 1));
      }
    }
  }
  throw lastError;
}

export function pacer(delayMs: number): (url: string) => Promise<void> {
  const lastCallAt = new Map<string, number>();

  return async function pace(url: string): Promise<void> {
    if (delayMs <= 0) return;
    const hostname = new URL(url).hostname;
    const now = Date.now();
    const last = lastCallAt.get(hostname);
    if (last !== undefined) {
      const remaining = delayMs - (now - last);
      if (remaining > 0) {
        await sleep(remaining);
      }
    }
    lastCallAt.set(hostname, Date.now());
  };
}
