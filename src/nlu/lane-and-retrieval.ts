import { SENSITIVE_FACT_KINDS, type CandidateFact, type CandidateProfile } from "../domain/candidate-profile.js";
import { factUsability } from "../domain/candidate-profile.js";
import { cosineSimilarity, type EmbeddingEncoder, type EmbeddingResult } from "./local-transformer.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const LANE_DESCRIPTIONS = {
  cybersecurity: "Cybersecurity analyst or security engineer work: SOC operations, security monitoring, detection engineering, incident response, digital forensics, malware analysis, vulnerability assessment, security automation, cloud security, threat investigation and SIEM tooling.",
  sdet: "Software development engineer in test, QA automation or quality engineering: test frameworks, functional and regression testing, API and database tests, UI automation, CI quality gates, release validation and defect investigation.",
  cloud: "Cloud and platform engineering: cloud infrastructure, AWS or Azure or GCP, identity and cloud security, DevOps, CI/CD, containers, Kubernetes, infrastructure automation, observability and platform reliability.",
  network: "Network and network-security engineering: TCP/IP, routing, switching, firewalls, DNS, VPN, packet analysis, NOC operations, network monitoring, network troubleshooting and network defense.",
} as const;
export type Lane = keyof typeof LANE_DESCRIPTIONS;
export type LaneProposal = { status: "PROPOSED"; lane: Lane; semanticScore: number; lexicalScore: number; scoreGap: number; scores: Record<Lane, { semantic: number; lexical: number }> } | { status: "UNKNOWN_REVIEW"; lane: null; reason: string; scores: Record<Lane, { semantic: number; lexical: number }> };

const LANE_TERMS: Record<Lane, string[]> = {
  cybersecurity: ["cybersecurity", "security analyst", "security engineer", "soc", "siem", "detection engineering", "incident response", "dfir", "malware", "vulnerability", "threat hunting", "splunk", "security operations"],
  sdet: ["sdet", "qa", "quality engineer", "test automation", "test engineer", "functional testing", "regression testing", "api testing", "playwright", "selenium", "testcontainers", "quality engineering"],
  cloud: ["cloud engineer", "cloud security", "aws", "azure", "gcp", "devops", "platform engineer", "kubernetes", "terraform", "infrastructure automation", "ci/cd", "docker"],
  network: ["network engineer", "network security", "noc", "tcp/ip", "routing", "switching", "firewall", "dns", "vpn", "wireshark", "packet analysis", "network operations"],
};

const aliasConfigSchema = z.object({
  version: z.literal(1),
  purpose: z.string().min(1),
  aliases: z.array(z.object({ canonical: z.string().min(1), forms: z.array(z.string().min(1)).min(2) }).strict()).min(1),
}).strict();
const aliasConfig = aliasConfigSchema.parse(JSON.parse(readFileSync(path.resolve("config/requirement-aliases.v1.json"), "utf8")));
const SAFE_ALIASES = aliasConfig.aliases.map((entry) => entry.forms.map((form) => form.toLocaleLowerCase("en-US")));

function normalizeLexical(text: string): string {
  let normalized = text.toLocaleLowerCase("en-US").replace(/[^a-z0-9+#./-]+/g, " ").replace(/\s+/g, " ").trim();
  for (const group of SAFE_ALIASES) {
    const canonical = group[0]!;
    for (const form of group) normalized = normalized.replace(new RegExp(`(^|\\s)${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\s)`, "g"), `$1${canonical}`);
  }
  return normalized;
}

function lexicalScore(text: string, terms: string[]): number {
  const normalized = normalizeLexical(text);
  const found = terms.filter((term) => normalized.includes(normalizeLexical(term)));
  return found.length / Math.max(1, terms.length);
}

export interface NluJobInput {
  title: string;
  descriptionText: string;
  requirements?: string[];
  responsibilities?: string[];
}

export async function proposeLane(job: NluJobInput, encoder: EmbeddingEncoder): Promise<{ proposal: LaneProposal; queryEmbedding: number[]; run: EmbeddingResult }> {
  const query = [job.title, ...(job.requirements ?? []), ...(job.responsibilities ?? []), job.descriptionText].join("\n");
  const run = await encoder.embed(query);
  const laneEntries = await Promise.all((Object.keys(LANE_DESCRIPTIONS) as Lane[]).map(async (lane) => {
    const embedded = await encoder.embed(LANE_DESCRIPTIONS[lane]);
    return [lane, { semantic: cosineSimilarity(run.vector, embedded.vector), lexical: lexicalScore(`${job.title}\n${(job.requirements ?? []).join("\n")}\n${(job.responsibilities ?? []).join("\n")}`, LANE_TERMS[lane]) }] as const;
  }));
  const scores = Object.fromEntries(laneEntries) as Record<Lane, { semantic: number; lexical: number }>;
  const ranked = (Object.keys(scores) as Lane[]).map((lane) => ({ lane, semantic: scores[lane].semantic, lexical: scores[lane].lexical, combined: scores[lane].semantic * 0.85 + scores[lane].lexical * 0.15 })).sort((a, b) => b.combined - a.combined);
  const first = ranked[0]!;
  const second = ranked[1]!;
  const gap = first.combined - second.combined;
  if (first.combined < 0.28 || gap < 0.025) {
    return { proposal: { status: "UNKNOWN_REVIEW", lane: null, reason: first.combined < 0.28 ? "No lane has a sufficiently direct title/requirement match." : "Top lane proposals are too close to select automatically.", scores }, queryEmbedding: run.vector, run };
  }
  return { proposal: { status: "PROPOSED", lane: first.lane, semanticScore: first.semantic, lexicalScore: first.lexical, scoreGap: gap, scores }, queryEmbedding: run.vector, run };
}

function factText(fact: CandidateFact): string {
  return [fact.value, fact.attributes.detail, ...(fact.attributes.technologies ?? []), ...(fact.attributes.roleTags ?? []), ...(fact.attributes.matchTerms ?? [])].filter(Boolean).join(". ");
}

export interface FactCandidate {
  factId: string;
  kind: CandidateFact["kind"];
  status: "approved-current";
  semanticScore: number;
  lexicalScore: number;
  sourceReference: string;
  sourceLocator: string | null;
  interpretation: "retrieval candidate only; does not prove proficiency, years, experience or eligibility";
}

/** Ranks approved, current facts only. Similarity is a retrieval signal, never decision evidence. */
export async function retrieveFactCandidates(input: { query: string; profile: CandidateProfile; asOf: string; encoder: EmbeddingEncoder }): Promise<FactCandidate[]> {
  const queryVector = (await input.encoder.embed(input.query)).vector;
  const facts = input.profile.facts.filter((fact) => factUsability(fact, input.asOf).usable && !SENSITIVE_FACT_KINDS.includes(fact.kind));
  const results = await Promise.all(facts.map(async (fact) => {
    const embedding = await input.encoder.embed(factText(fact));
    return {
      factId: fact.factId,
      kind: fact.kind,
      status: "approved-current" as const,
      semanticScore: cosineSimilarity(queryVector, embedding.vector),
      lexicalScore: lexicalScore(input.query, [fact.value, ...(fact.attributes.technologies ?? []), ...(fact.attributes.roleTags ?? [])]),
      sourceReference: fact.source.reference,
      sourceLocator: fact.source.locator ?? null,
      interpretation: "retrieval candidate only; does not prove proficiency, years, experience or eligibility" as const,
    };
  }));
  return results.sort((a, b) => (b.semanticScore + b.lexicalScore * 0.2) - (a.semanticScore + a.lexicalScore * 0.2));
}

export function currentApprovedFacts(profile: CandidateProfile, asOf: string): CandidateFact[] {
  return profile.facts.filter((fact) => factUsability(fact, asOf).usable);
}
