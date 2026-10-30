import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { factContentDigest, factUsability } from "../../src/domain/candidate-profile.js";
import { rowToFact } from "../../src/db/candidate-repo.js";
import {
  SAMPLE_TEXT, dbAvailable, getJson, login, postJson, sampleResponse, sha256, startHarness, upload, docxBytes,
  type Harness, type Session, FakeAi,
} from "../helpers/s1-harness.js";

// PostgreSQL JSONB reorders object keys. A review must still bind to the claim the reviewer saw,
// historical digests must keep working, and a real change must still be rejected as stale.

const ready = await dbAvailable();
const suite = ready ? describe : describe.skip;
const at = (quote: string) => {
  const start = SAMPLE_TEXT.indexOf(quote);
  if (start < 0) throw new Error(`missing quote ${quote}`);
  return { start, end: start + quote.length, quote };
};
const jobQuote = SAMPLE_TEXT.slice(SAMPLE_TEXT.indexOf("Northwind |"), SAMPLE_TEXT.indexOf("Present") + "Present".length);

suite("M3 review digest survives PostgreSQL", () => {
  let h: Harness;
  let s: Session;
  const ai = new FakeAi(() => sampleResponse({
    textSha256: sha256(SAMPLE_TEXT),
    facts: [
      { kind: "skill", value: "Python", attributes: {}, span: at("Python"), proposedBy: "rules" },
      { kind: "employment", value: "Northwind — SOC Analyst", attributes: {
        startDate: "2022-01", employer: "Northwind", title: "SOC Analyst", current: true,
        fieldSpans: {
          endDate: { quote: "Present", end: at("Present").end, start: at("Present").start },
          title: { quote: "SOC Analyst", end: at("SOC Analyst").end, start: at("SOC Analyst").start },
          employer: { start: at("Northwind").start, end: at("Northwind").end, quote: "Northwind" },
          startDate: { start: at("Jan 2022").start, quote: "Jan 2022", end: at("Jan 2022").end },
        },
      }, span: at(jobQuote), proposedBy: "rules" },
    ],
  }));

  beforeAll(async () => {
    h = await startHarness(ai);
    s = await login(h);
  }, 60_000);

  afterAll(async () => {
    await h?.close().catch(() => undefined);
    await h?.dropDatabase().catch(() => undefined);
  });

  it("approves a field-evidence fact after JSONB reordering, rejects a real change, and keeps the approval after restart", async () => {
    const uploaded = await upload(h, s, docxBytes("m3-digest"));
    expect(uploaded.statusCode).toBe(202);
    await h.queue.idle();
    const resumeId = uploaded.json().resumeId as string;
    const body = (await getJson(h, s, `/api/v1/resumes/${resumeId}/facts`)).body;
    expect(body.state).toBe("PROPOSED");
    const employment = body.facts.find((f: { kind: string }) => f.kind === "employment");
    const skill = body.facts.find((f: { kind: string }) => f.kind === "skill");
    const text = (await getJson(h, s, `/api/v1/resumes/${resumeId}/text`)).body.text as string;
    expect(text.slice(employment.attributes.fieldSpans.employer.start, employment.attributes.fieldSpans.employer.end)).toBe("Northwind");

    const stored = await h.pool.query("SELECT content_digest FROM candidate_facts WHERE fact_id=$1", [employment.factId]);
    expect(stored.rows[0].content_digest).toBe(employment.contentDigest);
    expect(employment.contentDigest).toBe(factContentDigest({ ...employment, verification: employment.verification, approvalStatus: employment.approvalStatus }));

    const stale = await postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, { factId: employment.factId, action: "approve", expectedDigest: "ab".repeat(32) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("STALE_FACT");
    expect((await h.pool.query("SELECT approval_status FROM candidate_facts WHERE fact_id=$1", [employment.factId])).rows[0].approval_status).toBe("pending");

    const approved = await postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, { factId: employment.factId, action: "approve", expectedDigest: employment.contentDigest });
    expect(approved.status).toBe(200);
    const again = await postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, { factId: employment.factId, action: "approve", expectedDigest: employment.contentDigest });
    expect(again.body.changed).toBe(false);

    const row = (await h.pool.query("SELECT * FROM candidate_facts WHERE fact_id=$1", [employment.factId])).rows[0];
    const loaded = rowToFact(row);
    expect(factUsability(loaded, "2026-10-20").usable).toBe(true);
    expect(factContentDigest(loaded)).toBe(employment.contentDigest);

    const restarted = await h.restart();
    h = restarted;
    s = await login(h);
    const after = (await getJson(h, s, `/api/v1/resumes/${resumeId}/facts`)).body.facts.find((f: { factId: string }) => f.factId === employment.factId);
    expect(after).toMatchObject({ approvalStatus: "approved", contentDigest: employment.contentDigest });
    const repeated = await postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, { factId: employment.factId, action: "approve", expectedDigest: after.contentDigest });
    expect(repeated.body.changed).toBe(false);

    const edited = await postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, {
      factId: skill.factId, action: "edit", expectedDigest: skill.contentDigest, edit: { value: "Python 3" },
    });
    expect(edited.status).toBe(200);
    const oldDigestRejected = await postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, { factId: skill.factId, action: "approve", expectedDigest: skill.contentDigest });
    expect(oldDigestRejected.status).toBe(409);
  }, 60_000);
});
