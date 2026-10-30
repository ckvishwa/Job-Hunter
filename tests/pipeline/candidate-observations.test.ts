import { describe, expect, it } from 'vitest';
import { parseCandidateAnswerObservations, usableApplicationAnswers, calculateUsResidence } from '../../src/pipeline/candidate-observations.js';
import { evaluateJob } from '../../src/decision/evaluate.js';
import { job, profile, fact } from '../helpers/decision-fixtures.js';

const base = { schemaVersion: 1, applicationIdentity: 'greenhouse:examplecorp:1000', recordedAt: '2026-10-08T14:49:56Z', answers: [] as unknown[] };
const answer = (over: Record<string, unknown> = {}) => ({ questionId: 'linkedin_profile', value: 'https://www.linkedin.com/in/example/', source: { kind: 'user-statement', reference: 'candidate reply' }, approvalStatus: 'pending', verifiedBy: null, verifiedAt: null, validUntil: null, scope: { applicationIdentity: base.applicationIdentity }, ...over });

describe('application answer observations', () => {
  it('never offers pending observations to the form', () => {
    const observed = parseCandidateAnswerObservations({ ...base, answers: [answer()] });
    expect(usableApplicationAnswers(observed, base.applicationIdentity, '2026-10-08')).toEqual([]);
  });
  it('requires an actual verifier and date for approved answers', () => {
    expect(() => parseCandidateAnswerObservations({ ...base, answers: [answer({ approvalStatus: 'approved' })] })).toThrow();
  });
  it('rejects placeholder contact and malformed LinkedIn values before use', () => {
    for (const [questionId, value] of [['email', 'your.email@example.com'], ['legal_first_name', 'First Name'], ['linkedin_profile', 'https://example.com/in/example']]) {
      const observed = parseCandidateAnswerObservations({ ...base, answers: [answer({ questionId, value, approvalStatus: 'approved', verifiedBy: 'candidate', verifiedAt: '2026-10-08' })] });
      expect(usableApplicationAnswers(observed, base.applicationIdentity, '2026-10-08')).toEqual([]);
    }
  });
  it('keeps answers scoped and expires dated approvals', () => {
    const observed = parseCandidateAnswerObservations({ ...base, answers: [answer({ value: 'https://www.linkedin.com/in/verified-person-123/', approvalStatus: 'approved', verifiedBy: 'candidate', verifiedAt: '2026-10-08', validUntil: '2026-10-09' })] });
    expect(usableApplicationAnswers(observed, base.applicationIdentity, '2026-10-08')).toHaveLength(1);
    expect(usableApplicationAnswers(observed, 'greenhouse:other:1', '2026-10-08')).toEqual([]);
    expect(usableApplicationAnswers(observed, base.applicationIdentity, '2026-10-10')).toEqual([]);
  });
  it('does not turn a candidate answer into extraction coverage approval', () => {
    const observed = parseCandidateAnswerObservations({ ...base, answers: [answer({ questionId: 'salary_range', value: '$85,000 - $105,000', approvalStatus: 'approved', verifiedBy: 'candidate', verifiedAt: '2026-10-08' })] });
    expect(usableApplicationAnswers(observed, base.applicationIdentity, '2026-10-08')).toHaveLength(1);
    const decision = evaluateJob({ structured: job({ requirements: [{ type: 'skill', value: 'Python' }] }), profile: profile([fact({ factId: 'python', kind: 'skill', value: 'Python' })]), review: null, asOf: '2026-10-08' });
    expect(decision.outcome).toBe('REVIEW');
    expect(decision.rules.find(rule => rule.ruleId === 'coverage:extraction')?.status).toBe('UNKNOWN');
  });
});

describe('rolling US residence calculation', () => {
  it('unions overlapping periods and excludes overseas absences once', () => {
    const result = calculateUsResidence({ asOf: '2026-10-08', complete: true, usPeriods: [{ start: '2021-01-01', end: '2025-01-01' }, { start: '2024-01-01', end: '2026-10-08' }], overseasAbsences: [{ start: '2024-06-01', end: '2024-07-01' }, { start: '2024-06-15', end: '2024-06-25' }] });
    expect(result.status).toBe('MEETS_DURATION');
    expect(result.usDays).toBe(result.windowDays - 31);
  });
  it('retains incomplete and borderline histories as unresolved', () => {
    expect(calculateUsResidence({ asOf: '2026-10-08', complete: false, usPeriods: [{ start: '2023-10-08', end: '2026-10-08' }], overseasAbsences: [] }).status).toBe('UNKNOWN');
    const exact = calculateUsResidence({ asOf: '2026-10-08', complete: true, usPeriods: [{ start: '2023-10-08', end: '2026-10-08' }], overseasAbsences: [] });
    expect(exact.usDays).toBe(exact.requiredDays);
    expect(exact.status).toBe('REVIEW_BOUNDARY');
  });
});
