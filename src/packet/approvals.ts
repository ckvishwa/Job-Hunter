import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { approvalSchema, type Approval } from "./readiness.js";

// Human approvals for one application packet, stored beside it. An approval is a record of a person's decision bound
// to the exact hashes they reviewed (see readiness.ts); software never creates one on its own initiative. The file is
// replaced atomically, history is append-only within it, and a later approval of the same kind supersedes an earlier
// one only when its bound values are the current ones.

const fileSchema = z.object({ schemaVersion: z.literal(1), approvals: z.array(approvalSchema).max(200) }).strict();

export function approvalsPath(packetDir: string): string {
  return path.join(packetDir, "approvals.json");
}

export function loadApprovals(packetDir: string): Approval[] {
  const file = approvalsPath(packetDir);
  if (!existsSync(file)) return [];
  const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error("approvals.json is not a valid approvals file; fix or remove it before continuing.");
  return parsed.data.approvals;
}

export function appendApproval(packetDir: string, approval: Approval): Approval[] {
  const checked = approvalSchema.parse(approval);
  const all = [...loadApprovals(packetDir), checked];
  mkdirSync(packetDir, { recursive: true });
  const file = approvalsPath(packetDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, approvals: all }, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return all;
}
