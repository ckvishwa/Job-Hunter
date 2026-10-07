import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { computeJdContentHash } from "../domain/canonical-job.js";

// Narrow provider boundary (docs/ard/00-SHARED-CONTRACTS.md section 7). A provider returns an
// UNVALIDATED proposal; it never sees or sets job identity, source hash or its own revision in
// the accepted result. Those are bound by orchestration (parse-job.ts).

export interface JobSemanticProvider {
  /** Identifies the proposer (model + prompt/schema revision, or fixture file hash). Bound by orchestration, not by the output. */
  readonly revision: string;
  extractJob(input: { rawJd: string; jdHash: string }): Promise<unknown>;
}

export class FixtureNotFoundError extends Error {
  constructor() {
    super("No stored fixture output exists for this exact JD content hash.");
    this.name = "FixtureNotFoundError";
  }
}

export class FixtureInputMismatchError extends Error {
  constructor() {
    super("The jdHash supplied does not match the hash of the supplied JD text.");
    this.name = "FixtureInputMismatchError";
  }
}

const fixtureFileSchema = z
  .object({
    fixtureSchemaVersion: z.literal(1),
    // The only provenance label allowed: a fixture is never a model. Keeps "manual annotation" from
    // being mistaken for extraction accuracy anywhere downstream.
    provenance: z.literal("MANUAL_ANNOTATION"),
    annotator: z.string().min(1),
    annotatedAt: z.string().min(1),
    notes: z.string().optional(),
    entries: z
      .array(
        z
          .object({
            // Fixture outputs are keyed by the exact content hash of the JD they were authored against.
            sourceJdHash: z.string().regex(/^[0-9a-f]{64}$/),
            label: z.string().optional(),
            // Deliberately unknown: tests store invalid proposals here to exercise the production validator.
            output: z.unknown(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type FixtureFile = z.infer<typeof fixtureFileSchema>;

/**
 * Deterministic stored-output provider. Looks up by the recomputed hash of the JD text and fails
 * explicitly for any input it has no fixture for; it never falls back to an unrelated entry.
 */
export class FixtureJobSemanticProvider implements JobSemanticProvider {
  readonly revision: string;
  readonly provenance = "MANUAL_ANNOTATION" as const;
  private readonly byHash = new Map<string, unknown>();

  constructor(fixture: unknown, revisionSeed: string) {
    const parsed = fixtureFileSchema.parse(fixture);
    for (const entry of parsed.entries) {
      if (this.byHash.has(entry.sourceJdHash)) {
        throw new Error("Fixture file has two entries for the same sourceJdHash.");
      }
      this.byHash.set(entry.sourceJdHash, entry.output);
    }
    this.revision = `fixture:${parsed.provenance}:${createHash("sha256").update(revisionSeed).digest("hex").slice(0, 12)}`;
  }

  static fromFile(filePath: string): FixtureJobSemanticProvider {
    const bytes = readFileSync(filePath, "utf-8");
    return new FixtureJobSemanticProvider(JSON.parse(bytes), bytes);
  }

  async extractJob(input: { rawJd: string; jdHash: string }): Promise<unknown> {
    const actual = computeJdContentHash(input.rawJd);
    if (actual !== input.jdHash) throw new FixtureInputMismatchError();
    if (!this.byHash.has(actual)) throw new FixtureNotFoundError();
    return structuredClone(this.byHash.get(actual));
  }
}
