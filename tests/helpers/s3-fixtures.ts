import type { BoardsConfig } from "../../src/jobs/runner.js";

// Synthetic official-board payloads in the exact shapes of the public Greenhouse and Lever board APIs, served through an injected fetch.
// Nothing here touches the network. Companies, boards and postings are invented.

const SENTENCE = "You will monitor security alerts, investigate suspicious activity, document findings clearly and work with the wider team to improve detection coverage every week.";
export const longJd = (extra = ""): string => `<p>${SENTENCE} ${SENTENCE} ${extra}</p><p>${SENTENCE}</p>`;

export interface GhJob { id: number; title: string; location: string; html?: string }

export const ghBody = (board: string, jobs: GhJob[]) => ({
  jobs: jobs.map((j) => ({
    id: j.id, title: j.title, absolute_url: `https://boards.greenhouse.io/${board}/jobs/${j.id}`,
    location: { name: j.location }, departments: [{ name: "Security" }], content: j.html ?? longJd(), updated_at: "2026-10-01T12:00:00Z",
  })),
});

export interface LeverJob { id: string; text: string; location: string; plain?: string }

export const leverBody = (board: string, jobs: LeverJob[]) =>
  jobs.map((j) => ({
    id: j.id, text: j.text, hostedUrl: `https://jobs.lever.co/${board}/${j.id}`, applyUrl: `https://jobs.lever.co/${board}/${j.id}/apply`,
    categories: { location: j.location, team: "Security", commitment: "Full-time" },
    descriptionPlain: j.plain ?? `${SENTENCE} ${SENTENCE} ${SENTENCE}`, createdAt: 1_790_000_000_000,
  }));

export interface ReplyShape { status?: number; body?: unknown; throws?: boolean; /** never answers; rejects only when the request is aborted */ hang?: boolean; delayMs?: number }
export type BoardReply = ReplyShape | (() => ReplyShape);

/** fetch() stand-in keyed by board token. Unknown boards answer 404, exactly as the real API does. Records every requested URL. */
export function fakeBoardFetch(replies: Record<string, BoardReply>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const m = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs/) ?? url.match(/api(?:\.eu)?\.lever\.co\/v0\/postings\/([^?]+)/);
    const token = m?.[1] ? decodeURIComponent(m[1]) : "";
    const raw = replies[token];
    if (raw === undefined) return new Response("not found", { status: 404 });
    const reply = typeof raw === "function" ? raw() : raw;
    if (reply.throws) throw new TypeError("fetch failed");
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (reply.hang) {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

export const BOARDS: BoardsConfig = {
  companies: [
    { company: "Acme Security", ats: "greenhouse", board: "acmesec" },
    { company: "Globex Cyber", ats: "greenhouse", board: "globexcyber" },
    { company: "Blocked Co", ats: "greenhouse", board: "blockedco" },
    { company: "Gone Inc", ats: "greenhouse", board: "goneinc" },
    { company: "Lever Labs", ats: "lever", board: "leverlabs" },
  ],
  excludeTitleKeywords: [],
};

export const ACME_JOBS: GhJob[] = [
  { id: 1001, title: "SOC Analyst I", location: "Austin, TX", html: longJd("Requirements: 2+ years of experience in a security operations center.") },
  { id: 1002, title: "Senior SOC Analyst", location: "Remote - US" },
  { id: 1003, title: "Software Engineer", location: "Austin, TX" },
  { id: 1004, title: "Incident Response Analyst", location: "London, UK" },
  { id: 1005, title: "Security Operations Center Analyst", location: "Remote" },
  { id: 1006, title: "Cybersecurity Analyst", location: "Denver, CO", html: longJd("Requirements: 7+ years of experience.") },
];

export const DEFAULT_REPLIES: Record<string, BoardReply> = {
  acmesec: { body: ghBody("acmesec", ACME_JOBS) },
  globexcyber: { body: ghBody("globexcyber", [{ id: 2001, title: "Security Monitoring Analyst", location: "New York, NY" }, { id: 2002, title: "Cloud Security Analyst", location: "Remote - US" }]) },
  blockedco: { status: 403, body: {} },
  // goneinc is absent: HTTP 404
  leverlabs: { body: leverBody("leverlabs", [{ id: "11111111-aaaa-bbbb-cccc-000000000001", text: "SOC Analyst", location: "Remote - US" }]) },
};
