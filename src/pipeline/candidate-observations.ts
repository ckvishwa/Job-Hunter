import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const observation = z.object({
  questionId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  value: z.string().trim().min(1).max(300).nullable(),
  source: z.object({ kind: z.enum(['user-statement', 'draft']), reference: z.string().min(1).max(160) }).strict(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']),
  verifiedBy: z.string().min(1).nullable(),
  verifiedAt: date.nullable(),
  validUntil: date.nullable(),
  scope: z.object({ applicationIdentity: z.string().min(1) }).strict(),
}).strict().superRefine((answer, ctx) => {
  if (answer.approvalStatus === 'approved' && (!answer.value || !answer.verifiedBy || !answer.verifiedAt || answer.source.kind !== 'user-statement'))
    ctx.addIssue({ code: 'custom', message: 'Approved answer requires a user statement, value, verifier and date.' });
});
export const candidateAnswerObservationsSchema = z.object({
  schemaVersion: z.literal(1),
  applicationIdentity: z.string().min(1),
  recordedAt: z.string().datetime(),
  answers: z.array(observation).max(100),
}).strict().superRefine((data, ctx) => {
  const ids = new Set<string>();
  data.answers.forEach((answer, index) => {
    if (ids.has(answer.questionId)) ctx.addIssue({ code: 'custom', path: ['answers', index], message: 'Duplicate question ID.' });
    ids.add(answer.questionId);
    if (answer.scope.applicationIdentity !== data.applicationIdentity) ctx.addIssue({ code: 'custom', path: ['answers', index], message: 'Answer scope differs from application.' });
  });
});
export type CandidateAnswerObservations = z.infer<typeof candidateAnswerObservationsSchema>;
export const parseCandidateAnswerObservations = (input: unknown): CandidateAnswerObservations => candidateAnswerObservationsSchema.parse(input);

function validValue(questionId: string, value: string): boolean {
  if (/\b(?:placeholder|example|your|first name|last name|test user|n\/a|tbd)\b/i.test(value)) return false;
  if (questionId === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/example\.(?:com|org|net)$/i.test(value);
  if (questionId === 'phone') return value.replace(/\D/g, '').length >= 10;
  if (questionId === 'linkedin_profile') {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase()) && /^\/(?:in|pub)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.username && !url.password;
    } catch { return false; }
  }
  return true;
}

/** Observations are never a CandidateProfile. Only separately verified, current answers
 * can be proposed to a later form adapter; this function performs no profile promotion. */
export function usableApplicationAnswers(input: CandidateAnswerObservations, applicationIdentity: string, asOf: string) {
  return input.answers.filter(answer => answer.approvalStatus === 'approved' && answer.scope.applicationIdentity === applicationIdentity && !!answer.verifiedBy && !!answer.verifiedAt && !!answer.value && (!answer.validUntil || answer.validUntil >= asOf) && validValue(answer.questionId, answer.value));
}

export type DatePeriod = { start: string; end: string };
const day = (value: string): number => {
  if (!date.safeParse(value).success) throw new Error('Invalid ISO calendar date.');
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('Invalid ISO calendar date.');
  return ms / 86_400_000;
};
function unionDays(periods: DatePeriod[], start: number, end: number): Array<[number, number]> {
  const intervals = periods.map(p => [Math.max(start, day(p.start)), Math.min(end, day(p.end))] as [number, number])
    .filter(([a, b]) => a <= b).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of intervals) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
/** Calendar-day calculation for candidate review, not a Public Trust adjudication. Endpoints
 * are inclusive UTC dates. Boundary cases remain unresolved for a human to confirm. */
export function calculateUsResidence(input: { asOf: string; complete: boolean; usPeriods: DatePeriod[]; overseasAbsences: DatePeriod[] }) {
  const end = day(input.asOf);
  const asOf = new Date(end * 86_400_000);
  const windowStart = new Date(asOf); windowStart.setUTCFullYear(windowStart.getUTCFullYear() - 5);
  const requiredStart = new Date(asOf); requiredStart.setUTCFullYear(requiredStart.getUTCFullYear() - 3);
  const start = day(windowStart.toISOString().slice(0, 10));
  const requiredDays = end - day(requiredStart.toISOString().slice(0, 10)) + 1;
  for (const p of [...input.usPeriods, ...input.overseasAbsences]) if (day(p.start) > day(p.end)) throw new Error('Period ends before it starts.');
  const us = unionDays(input.usPeriods, start, end);
  const absent = unionDays(input.overseasAbsences, start, end);
  const covered = us.reduce((n, [a, b]) => n + b - a + 1, 0);
  const excluded = absent.reduce((n, [a, b]) => n + us.reduce((overlap, [c, d]) => overlap + Math.max(0, Math.min(b, d) - Math.max(a, c) + 1), 0), 0);
  const usDays = covered - excluded;
  return { status: !input.complete ? 'UNKNOWN' : Math.abs(usDays - requiredDays) <= 1 ? 'REVIEW_BOUNDARY' : usDays > requiredDays ? 'MEETS_DURATION' : 'BELOW_DURATION', usDays, requiredDays, windowDays: end - start + 1, windowStart: windowStart.toISOString().slice(0, 10), windowEnd: input.asOf, assumption: 'Inclusive UTC calendar dates; overlapping periods counted once; overseas absences excluded. Review only, not federal adjudication.' } as const;
}
