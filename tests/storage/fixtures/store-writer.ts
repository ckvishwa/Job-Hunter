// Child process used by tests/storage/job-store.test.ts: performs N locked read-modify-write
// appends to the store, each acknowledged update adding one distinct job.
import { updateJobs } from "../../../src/storage/job-store.js";
import type { JobPosting } from "../../../src/adapters/types.js";

const [file, prefix, countArg] = process.argv.slice(2) as [string, string, string];
const count = Number(countArg);

function job(id: string): JobPosting {
  return {
    id,
    source: "writer",
    sourceType: "greenhouse",
    company: "Acme",
    title: `Role ${id}`,
    location: "Remote",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: id,
    postingDate: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: `https://acme.example/jobs/${id}`,
    applyUrl: `https://acme.example/jobs/${id}`,
    descriptionText: `Description for ${id}. `.repeat(10),
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: [],
    discoveredFrom: ["writer"],
    rawMetadata: {},
  };
}

for (let i = 0; i < count; i += 1) {
  await updateJobs(file, (current) => [...current, job(`${prefix}-${i}`)], { timeoutMs: 30_000 });
}
console.log("done");
