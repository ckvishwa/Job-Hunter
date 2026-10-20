import { AiServiceError, type AiClient } from "../ai/client.js";
import { buildPendingFacts, ExtractionIntegrityError } from "../candidate/fact-lifecycle.js";
import type { CandidateRepo } from "../db/candidate-repo.js";
import type { FileStore } from "./file-store.js";

// Single in-process worker. Durable state lives in resume_versions, so a crash leaves UPLOADED/EXTRACTING rows that
// `recover()` re-queues at startup. No resume text or fact values are ever logged.

export interface ExtractionEvent {
  versionId: string;
  outcome: "PROPOSED" | "FAILED" | "SKIPPED" | "WORKER_ERROR";
  code?: string;
  facts?: number;
}

export class ExtractionQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = new Set<string>();

  constructor(private readonly deps: { repo: CandidateRepo; ai: AiClient; files: FileStore; onEvent?: (e: ExtractionEvent) => void }) {}

  enqueue(versionId: string): void {
    if (this.queued.has(versionId)) return;
    this.queued.add(versionId);
    this.tail = this.tail
      .then(() => this.process(versionId))
      // An unexpected error (for example the database going away mid-job) must not stall the queue or vanish silently. The version
      // stays UPLOADED/EXTRACTING, so recover() at the next start picks it up again.
      .catch((error: unknown) => this.deps.onEvent?.({ versionId, outcome: "WORKER_ERROR", code: error instanceof Error ? error.name : "UnknownError" }))
      .finally(() => this.queued.delete(versionId));
  }

  async recover(): Promise<number> {
    const ids = await this.deps.repo.pendingVersionIds();
    ids.forEach((id) => this.enqueue(id));
    return ids.length;
  }

  /** Resolves when everything enqueued so far has finished (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.tail;
      await seen;
    } while (seen !== this.tail);
  }

  private async process(versionId: string): Promise<void> {
    const { repo, ai, files, onEvent } = this.deps;
    const loaded = await repo.getVersionWithResume(versionId);
    if (!loaded || (loaded.version.state !== "UPLOADED" && loaded.version.state !== "EXTRACTING")) {
      onEvent?.({ versionId, outcome: "SKIPPED" });
      return;
    }
    if (!(await repo.beginExtraction(versionId))) {
      onEvent?.({ versionId, outcome: "SKIPPED" });
      return;
    }
    const fail = async (code: string, detail: string): Promise<void> => {
      await repo.failExtraction(versionId, code, detail);
      onEvent?.({ versionId, outcome: "FAILED", code });
    };
    let bytes: Buffer;
    try {
      bytes = files.read(loaded.resume.storageRef);
    } catch {
      return fail("STORED_FILE_MISSING", "The stored upload could not be read.");
    }
    let response;
    try {
      response = await ai.extractResume(bytes, loaded.resume.fileType);
    } catch (error) {
      if (error instanceof AiServiceError) return fail(error.code, error.message);
      return fail("INTERNAL_ERROR", "Extraction failed unexpectedly.");
    }
    try {
      if (response.fileType !== loaded.resume.fileType) return fail("AI_SCHEMA_INVALID", "The extracted document type did not match the upload.");
      const proposed = loaded.resume.fileType === "text"
        ? { ...response, facts: response.facts.filter((fact) => ["legal_name", "phone", "email", "skill"].includes(fact.kind)) }
        : response;
      const { drafts, dropped } = buildPendingFacts(proposed, {
        resumeReference: `resume-${loaded.resume.sha256.slice(0, 12)}.${loaded.resume.fileType}`,
        scope: versionId,
      });
      const warnings = [...response.warnings, ...dropped.map((d) => ({ code: d.code, message: d.message }))];
      const result = await repo.completeExtraction({
        versionId, userId: loaded.userId, parserRevision: response.parserRevision, text: response.text,
        textSha256: response.textSha256, warnings, stats: response.stats, drafts,
      });
      onEvent?.({ versionId, outcome: result.completed ? "PROPOSED" : "SKIPPED", facts: result.inserted });
    } catch (error) {
      if (error instanceof ExtractionIntegrityError) return fail("AI_SCHEMA_INVALID", error.message);
      return fail("INTERNAL_ERROR", "Saving the extraction failed.");
    }
  }
}
