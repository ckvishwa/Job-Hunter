import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Private storage for uploaded resumes. Files are named by content hash; no user-supplied name ever reaches the filesystem.
// The upload directory lives under gitignored private-runtime/.

const REF = /^[a-f0-9]{64}\.(pdf|docx|text)$/;

export interface FileStore {
  save(sha256: string, fileType: "pdf" | "docx" | "text", bytes: Buffer): string;
  read(ref: string): Buffer;
}

export function createFileStore(root: string): FileStore {
  mkdirSync(root, { recursive: true });
  const resolveRef = (ref: string): string => {
    if (!REF.test(ref)) throw new Error("Invalid storage reference.");
    return path.join(root, ref);
  };
  return {
    save(sha256, fileType, bytes) {
      const ref = `${sha256}.${fileType}`;
      const target = resolveRef(ref);
      if (existsSync(target) && statSync(target).size === bytes.length) return ref;
      const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, target);
      return ref;
    },
    read(ref) {
      return readFileSync(resolveRef(ref));
    },
  };
}
