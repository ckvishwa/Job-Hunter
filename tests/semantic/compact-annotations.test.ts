import { describe, it, expect } from 'vitest';
import { inventorySource } from '../../src/semantic/source-coverage.js';
import { assembleAnnotations, annotationRequestSchema } from '../../src/semantic/compact-annotations.js';
import { validateStructuredProposal } from '../../src/domain/structured-job.js';
import { computeJdContentHash } from '../../src/domain/canonical-job.js';
import { evaluateJob } from '../../src/decision/evaluate.js';
import { fact, profile } from '../helpers/decision-fixtures.js';
const source = 'Requirements:\r\n- Ability to think creatively 😀\r\n  when ownership is unclear.\r\n- 3+ years of software engineering with Go or Rust.\r\nNice to have:\r\n- Python\r\n- Python\r\nWork arrangements:\r\nRemote or office work is offered.';
describe('compact source annotations', () => {
    it('preserves exact Unicode/CRLF items, continuations, duplicate bullets and variants', () => {
        const inventory = inventorySource(source);
        expect(inventory.items.filter(i => i.section === 'required')).toHaveLength(2);
        expect(inventory.items.filter(i => i.section === 'preferred')).toHaveLength(2);
        expect(inventory.items.find(i => i.text.includes('creatively'))?.text).toContain('\r\n  when');
        expect(new Set(inventory.items.map(i => i.id)).size).toBe(inventory.items.length);
        for (const i of inventory.items)
            expect(source.slice(i.start, i.end)).toBe(i.text);
    });
    it('retains unknown headings and heading-free text as unresolved source', () => {
        const inv = inventorySource('Unexpected expectations:\nThink independently.\nRemote work available.');
        expect(inv.items.some(i => i.text.includes('Think independently'))).toBe(true);
        expect(inv.items.some(i => i.text.includes('Remote'))).toBe(true);
    });
    it('recognizes lowercase headings and preserves introductions before bullets', () => {
        const inv = inventorySource('minimum qualifications\r\nAll applicants should bring:\r\n- Problem-solving ability\r\n- Patience\r\npreferred qualifications\r\n- Curiosity');
        expect(inv.items.filter(i => i.section === 'required').map(i => i.text)).toEqual(['All applicants should bring:', 'Problem-solving ability', 'Patience']);
        expect(inv.items.find(i => i.text === 'Curiosity')?.section).toBe('preferred');
    });
    it('rejects unknown, duplicate and omitted source IDs', () => {
        const raw = 'Requirements:\n- Ability to reason.';
        const inv = inventorySource(raw);
        const s = inv.items.find(i => i.section === 'required')!.id;
        const a = { sourceId: s, kind: 'soft_skill', level: 'required' };
        expect(() => assembleAnnotations(raw, inv, { version: 1, annotations: [] })).toThrow(/omitted/);
        expect(() => assembleAnnotations(raw, inv, { version: 1, annotations: [{ ...a, sourceId: 'invented' }] })).toThrow(/unknown/);
        expect(() => assembleAnnotations(raw, inv, { version: 1, annotations: [a, a] })).toThrow(/duplicate/);
    });
    it('reconstructs abstract abilities without claiming candidate proficiency', () => {
        const raw = 'Requirements:\n- Ability to think creatively 😀.';
        const inv = inventorySource(raw);
        const s = inv.items.find(i => i.section === 'required')!.id;
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: s, kind: 'soft_skill', level: 'required' }] });
        expect(proposal.requirements[0]?.value).toBe('Ability to think creatively 😀.');
        const result = validateStructuredProposal(raw, { jobId: 'x', jdHash: computeJdContentHash(raw), parserVersion: 'test', providerRevision: 'test', now: new Date().toISOString() }, proposal);
        expect(result.ok).toBe(true);
    });
    it('permits an explicit unresolved mixed clause without demanding invented logic', () => {
        const raw = 'Requirements:\n- Testing and design for web apps and/or APIs.';
        const inv = inventorySource(raw);
        const item = inv.items.find(i => i.section === 'required')!;
        const schema: any = annotationRequestSchema([item]);
        const alternatives = schema.properties.annotations.items.anyOf as any[];
        expect(alternatives.some(branch => branch.properties.kind.const === 'unresolved' && !branch.required.includes('logic'))).toBe(true);
        const assembled = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: item.id, kind: 'unresolved', unresolvedReason: 'Mixed connectors and shared qualifier need review' }] });
        expect(assembled.proposal.requirements).toHaveLength(0);
        expect(assembled.unresolved).toMatchObject([{ sourceId: item.id }]);
        expect(() => assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: item.id, kind: 'skill', logic: { op: 'all_of', args: ['Testing', 'design', 'web apps', 'APIs'] } }] })).toThrow(/mixed connectors.*nested logic or unresolved/);
    });
    it('lowers nested inclusive boolean logic without changing its meaning', () => {
        const raw = 'Requirements:\n- Go or (Python and SQL).';
        const inv = inventorySource(raw);
        const s = inv.items.find(i => i.section === 'required')!.id;
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: s, kind: 'skill', level: 'required', logic: { op: 'any_of', args: ['Go', { op: 'all_of', args: ['Python', 'SQL'] }] } }] });
        expect(proposal.alternativeGroups).toHaveLength(2);
        expect(proposal.requirements.map(r => r.value)).toEqual(['Go', 'Python', 'Go', 'SQL']);
    });
    it('rejects unsupported years, invented terms and unknown fields', () => {
        const raw = 'Requirements:\n- 3+ years of software engineering with Go or Rust.';
        const inv = inventorySource(raw);
        const s = inv.items.find(i => i.section === 'required')!.id;
        for (const a of [{ sourceId: s, kind: 'role_experience', level: 'required', minimumYears: 5, scope: 'role' }, { sourceId: s, kind: 'skill', level: 'required', logic: { op: 'any_of', args: ['Go', 'Java'] } }, { sourceId: s, kind: 'skill', level: 'required', invented: true }])
            expect(() => assembleAnnotations(raw, inv, { version: 1, annotations: [a] })).toThrow();
    });
    it('keeps years scoped to the stated tool and rejects scope borrowed from another clause', () => {
        const raw = 'Requirements:\n- 3+ years using Go.';
        const inv = inventorySource(raw);
        const sourceId = inv.items[0]!.id;
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId, kind: 'tool', minimumYears: 3, scope: 'tool', scopeValue: 'Go' }] });
        expect(proposal.requirements[0]).toMatchObject({ value: 'Go', minimumYears: 3, scope: { kind: 'tool', value: 'Go' } });
        const multi = 'Requirements:\n- 3 years using Go and 5 years using Rust.';
        const multiInv = inventorySource(multi);
        expect(() => assembleAnnotations(multi, multiInv, { version: 1, annotations: [{ sourceId: multiInv.items[0]!.id, kind: 'tool', minimumYears: 3, scope: 'tool', scopeValue: 'Rust' }] })).toThrow(/multiple years clauses/);
    });
    it('uses the lower bound of a source-supported years range without inventing a higher minimum', () => {
        const raw = 'Required experience: Approximately 1–3 years of software testing experience.';
        const inv = inventorySource(raw);
        const sourceId = inv.items.find(i => i.section === 'required')!.id;
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId, kind: 'role_experience', minimumYears: 1, scope: 'role' }] });
        expect(proposal.requirements[0]?.minimumYears).toBe(1);
        expect(() => assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId, kind: 'role_experience', minimumYears: 3, scope: 'role' }] })).toThrow(/unsupported or unscoped years/);
    });
    it('keeps the predicate and qualifiers around alternative terms', () => {
        const raw = 'Preferred qualifications:\n- Knowledge of macOS or iOS internals.';
        const inv = inventorySource(raw);
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: inv.items[0]!.id, kind: 'domain_knowledge', logic: { op: 'any_of', args: ['macOS', 'iOS'] } }] });
        expect(proposal.requirements.map(r => r.value)).toEqual(['Knowledge of macOS internals', 'Knowledge of iOS internals']);
    });
    it('accepts omitted articles between exact alternatives without losing the shared qualification', () => {
        const raw = 'Minimum qualifications:\n- Bachelor’s degree in computer science, software engineering, or a related technical field.';
        const inv = inventorySource(raw);
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: inv.items[0]!.id, kind: 'degree', logic: { op: 'any_of', args: ['computer science', 'software engineering', 'related technical field'] } }] });
        expect(proposal.requirements.map(r => r.value)).toEqual([
            'Bachelor’s degree in computer science',
            'Bachelor’s degree in software engineering',
            'Bachelor’s degree in related technical field',
        ]);
    });
    it('reconstructs exact alternatives when the model repeats a shared source predicate', () => {
        const raw = 'Requirements:\n- Experience with Go or Rust.';
        const inv = inventorySource(raw);
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: inv.items[0]!.id, kind: 'skill', logic: { op: 'any_of', args: ['Experience with Go', 'Experience with Rust'] } }] });
        expect(proposal.requirements.map(r => r.value)).toEqual(['Experience with Go', 'Experience with Rust']);
    });
    it('resolves a repeated source word by its unique ordered connector context', () => {
        const raw = 'Requirements:\n- Strong leadership, communication, ownership, and influencing skills, plus excellent verbal and written English communication skills.';
        const inv = inventorySource(raw);
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: inv.items[0]!.id, kind: 'skill', logic: { op: 'all_of', args: ['leadership', 'communication', 'ownership', 'influencing'] } }] });
        expect(proposal.requirements).toHaveLength(4);
        expect(proposal.requirements[1]?.value).toContain('Strong communication');
        expect(proposal.requirements[3]?.value).toContain('excellent verbal and written English communication skills');
    });
    it('aligns flat connectors to their explicit source operator and rejects omitted qualifiers', () => {
        const andRaw = 'Requirements:\n- Go and Rust.';
        const andInv = inventorySource(andRaw);
        const andResult = assembleAnnotations(andRaw, andInv, { version: 1, annotations: [{ sourceId: andInv.items[0]!.id, kind: 'skill', logic: { op: 'any_of', args: ['Go', 'Rust'] } }] });
        expect(andResult.proposal.alternativeGroups).toHaveLength(0);

        const orRaw = 'Requirements:\n- Go or Rust.';
        const orInv = inventorySource(orRaw);
        const orResult = assembleAnnotations(orRaw, orInv, { version: 1, annotations: [{ sourceId: orInv.items[0]!.id, kind: 'skill', logic: { op: 'all_of', args: ['Go', 'Rust'] } }] });
        expect(orResult.proposal.alternativeGroups).toMatchObject([{ operator: 'any_of' }]);

        const qualifiedRaw = 'Requirements:\n- Go on Linux or Rust on Windows.';
        const qualifiedInv = inventorySource(qualifiedRaw);
        expect(() => assembleAnnotations(qualifiedRaw, qualifiedInv, { version: 1, annotations: [{ sourceId: qualifiedInv.items[0]!.id, kind: 'skill', logic: { op: 'any_of', args: ['Go', 'Rust'] } }] })).toThrow(/source match/);
    });
    it('one supported alternative passes while absent evidence and coverage remain UNKNOWN', () => {
        const raw = 'Requirements:\n- Go or Rust.\n- Ability to reason.';
        const inv = inventorySource(raw);
        const { proposal } = assembleAnnotations(raw, inv, { version: 1, annotations: [{ sourceId: inv.items[0]!.id, kind: 'language', logic: { op: 'any_of', args: ['Go', 'Rust'] } }, { sourceId: inv.items[1]!.id, kind: 'soft_skill' }] });
        const checked = validateStructuredProposal(raw, { jobId: 'x', jdHash: computeJdContentHash(raw), providerRevision: 'test', parserVersion: 'test', now: new Date().toISOString() }, proposal);
        if (!checked.ok)
            throw new Error(JSON.stringify(checked));
        const decision = evaluateJob({ structured: checked.job, profile: profile([fact({ factId: 'f-go', kind: 'skill', value: 'Go' })]), review: null, asOf: '2026-10-08', evaluatedAt: '2026-10-08T00:00:00.000Z' });
        expect(decision.rules.find(r => r.ruleId.startsWith('group:'))).toMatchObject({ status: 'PASS', factIds: ['f-go'] });
        expect(decision.rules.find(r => r.ruleId === 'req:' + inv.items[1]!.id)?.status).toBe('UNKNOWN');
        expect(decision.outcome).toBe('REVIEW');
    });
});
