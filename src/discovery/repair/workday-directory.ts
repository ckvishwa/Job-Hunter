const SLUG = /^[A-Za-z0-9._-]+$/;
/** Instance ids stored in the tenant field by the public directory. They are not employers. */
export const WORKDAY_JUNK_TENANT = /^wd\d+$/i;
const WORKDAY_INSTANCE = /^wd\d+$/i;

export interface WorkdayBoard {
  tenant: string;
  instance: string;
  site: string;
  careersUrl: string;
  jobsUrl: string;
}

export type WorkdayDirectoryResult =
  | { ok: true; board: WorkdayBoard }
  | { ok: false; reason: string };

/** Reject a junk directory row without calling fetch. A valid row is posted to its CXS jobs endpoint. */
export async function fetchWorkdayBoard(line: string, fetchImpl: typeof fetch, timeoutMs = 20_000): Promise<{ requested: boolean; result: WorkdayDirectoryResult; status: number | null; body: string }> {
  const result = validateWorkdayDirectoryLine(line);
  if (!result.ok) return { requested: false, result, status: null, body: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(result.board.jobsUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }),
    });
    const body = await response.text();
    return { requested: true, result, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}
export function validateWorkdayDirectoryLine(line: string): WorkdayDirectoryResult {
  const parts = String(line).split("|");
  if (parts.length !== 3) return { ok: false, reason: "A Workday row needs tenant, instance, and site. Missing coordinates were not guessed." };
  const [tenant, instance, site] = parts;
  if (!tenant || !instance || !site || !SLUG.test(tenant) || !SLUG.test(instance) || !SLUG.test(site)) {
    return { ok: false, reason: "A Workday coordinate is missing or contains an unsafe character." };
  }
  if (WORKDAY_JUNK_TENANT.test(tenant)) {
    return { ok: false, reason: `Tenant "${tenant}" is a Workday instance id, not an employer. No request is made.` };
  }
  if (!WORKDAY_INSTANCE.test(instance)) {
    return { ok: false, reason: `Instance "${instance}" is not a verified Workday shard.` };
  }
  return {
    ok: true,
    board: {
      tenant,
      instance,
      site,
      careersUrl: `https://${tenant}.${instance}.myworkdayjobs.com/${site}`,
      jobsUrl: `https://${tenant}.${instance}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
    },
  };
}
