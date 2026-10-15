import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// The only files the Project API can ever read. Paths are fixed constants relative to the repository root: no request value is
// ever part of a path. Reads are capped, must resolve (after symlinks) inside the root, and fail with a typed error.

export const PROJECT_FILES = {
  ledger: "docs/PROGRESS_LEDGER.json",
  prd: "docs/PRD.md",
  notebook: "docs/team/ENGINEERING_NOTEBOOK.md",
} as const;
export const KT_FILES = ["docs/kt/HANI_KT_PLAN.md", "docs/kt/HANI_ONBOARDING.md", "docs/kt/LOCAL_SETUP.md", "docs/kt/PROJECT_WALKTHROUGH.md"] as const;

export type ProjectSourceName = keyof typeof PROJECT_FILES;
export type ProjectErrorCode = "PROJECT_SOURCE_MISSING" | "PROJECT_SOURCE_INVALID" | "PROJECT_SOURCE_TOO_LARGE";

export class ProjectSourceError extends Error {
  constructor(readonly code: ProjectErrorCode, readonly source: string, message: string) {
    super(message);
  }
}

const MAX_BYTES = 4 * 1024 * 1024;

export interface ProjectSources {
  readFixed(name: ProjectSourceName): Promise<{ text: string; sha256: string; path: string }>;
  /** Optional files (KT notes): a missing or unreadable file is simply absent. */
  readOptional(relativePath: (typeof KT_FILES)[number]): Promise<string | null>;
}

export function createProjectSources(root: string): ProjectSources {
  const base = path.resolve(root);
  let realBase: Promise<string> | null = null;
  const baseReal = (): Promise<string> => (realBase ??= fs.realpath(base));

  async function load(relative: string): Promise<{ text: string; sha256: string; path: string } | "missing"> {
    const full = path.join(base, ...relative.split("/"));
    let real: string;
    try {
      real = await fs.realpath(full);
    } catch {
      return "missing";
    }
    const rootReal = await baseReal();
    const inside = path.relative(rootReal, real);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new ProjectSourceError("PROJECT_SOURCE_INVALID", relative, "A project source resolves outside the repository.");
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new ProjectSourceError("PROJECT_SOURCE_INVALID", relative, "A project source is not a regular file.");
    if (stat.size > MAX_BYTES) throw new ProjectSourceError("PROJECT_SOURCE_TOO_LARGE", relative, "A project source is too large to display.");
    const bytes = await fs.readFile(real);
    return { text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex"), path: relative };
  }

  return {
    async readFixed(name) {
      const relative = PROJECT_FILES[name];
      const result = await load(relative);
      if (result === "missing") throw new ProjectSourceError("PROJECT_SOURCE_MISSING", relative, `The project source ${relative} is not available on this machine.`);
      return result;
    },
    async readOptional(relativePath) {
      try {
        const result = await load(relativePath);
        return result === "missing" ? null : result.text;
      } catch {
        return null;
      }
    },
  };
}
