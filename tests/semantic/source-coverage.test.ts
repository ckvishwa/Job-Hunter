import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inventorySource, buildExtractionCoverage, extractQualificationSections, extractExperienceThresholds, extractAlternativeClauses } from '../../src/semantic/source-coverage.js';
const raw = readFileSync(new URL('../fixtures/stripe-client-platform-security-engineer.jd.txt', import.meta.url), 'utf8');
const ref = JSON.parse(readFileSync(new URL('../fixtures/stripe-client-platform-security-engineer.reference.json', import.meta.url), 'utf8'));
describe('generic source coverage', () => {
    it('recognizes a flattened What you should have section and retains its years range', () => {
        const jd = 'What you\'ll be doing Build tests. What you should have 3-5+ years of QA automation experience. Hands-on Tosca experience. Familiarity with Oracle ERP Cloud. Preferred Qualifications Experience with SaaS QA automation. Candidates must reside in or be willing to relocate to the Bay Area.';
        const inventory = inventorySource(jd);
        const required = inventory.items.filter(i => i.section === 'required');
        expect(required.map(i => i.text)).toEqual([
            '3-5+ years of QA automation experience.', 'Hands-on Tosca experience.', 'Familiarity with Oracle ERP Cloud.',
        ]);
        expect(inventory.items.filter(i => i.section === 'preferred').map(i => i.text)).toEqual(['Experience with SaaS QA automation.']);
        expect(inventory.items.some(i => i.section === 'work' && i.text.includes('relocate'))).toBe(true);
        for (const item of inventory.items) expect(jd.slice(item.start, item.end)).toBe(item.text);
    });
    it('preserves a misspelled required-experience heading and a US residence clause intact', () => {
        const jd = 'REQUIRED EXPEREINCE: Approximately 1–3 years of software testing experience. Hands-on functional testing. Candidates must have lived in the United States for at least 3 of the past 5 years. PREFERRED EXPERIENCE: Academic or project automation experience. EDUCATION & CERTIFICATIONS: Bachelor’s degree or equivalent practical experience.';
        const inv = inventorySource(jd);
        expect(inv.items.filter(i => i.section === 'required').map(i => i.text)).toEqual([
            'Approximately 1–3 years of software testing experience.', 'Hands-on functional testing.',
        ]);
        expect(inv.items.find(i => i.section === 'work')?.text).toBe('Candidates must have lived in the United States for at least 3 of the past 5 years.');
        expect(inv.items.filter(i => i.section === 'preferred').map(i => i.text)).toEqual(['Academic or project automation experience.']);
        expect(inv.items.some(i => i.section === 'context' && i.text.includes('Bachelor'))).toBe(true);
        expect(extractExperienceThresholds(jd).map(i => i.years)).toEqual([1]);
    });
    it('does not treat qualification headings embedded in prose as section boundaries', () => {
        const jd = "Responsibilities Deeply understand customer use cases, Product Requirements Documents, and Software Design Documents. Who you are We're looking for someone who meets the minimum requirements to be considered for the role. If you meet these requirements, you are encouraged to apply. The preferred qualifications are a bonus, not a requirement. Minimum requirements Bachelor’s degree in computer science. Preferred qualifications Experience with firmware.";
        const inv = inventorySource(jd);
        expect(inv.items.filter(i => i.section === 'required').map(i => i.text)).toEqual(["Bachelor’s degree in computer science."]);
        expect(inv.items.filter(i => i.section === 'preferred').map(i => i.text)).toEqual(['Experience with firmware.']);
        expect(inv.items.some(i => i.section === 'responsibility' && i.text.includes('Product Requirements Documents'))).toBe(true);
        expect(inv.items.some(i => i.text.includes('meets the minimum requirements') && i.section !== 'required')).toBe(true);
    });
    it('matches frozen Stripe qualification items without employer-specific split rules', () => {
        const sections = extractQualificationSections(raw);
        expect(sections.find(s => s.level === 'required')?.items.map(i => i.text)).toEqual(ref.minimumQualifications);
        expect(sections.find(s => s.level === 'preferred')?.items.map(i => i.text)).toEqual(ref.preferredQualifications);
        expect(extractExperienceThresholds(raw).map(i => i.years)).toEqual([4, 4]);
        // The frozen old reference omitted a third OR clause in preferred qualifications.
        expect(extractAlternativeClauses(raw)).toHaveLength(3);
    });
    it('preserves all work statements, broader context and exact original spans', () => {
        const inv = inventorySource(raw);
        for (const text of ref.workArrangement)
            expect(inv.items.some(i => i.text === text)).toBe(true);
        for (const i of inv.items)
            expect(raw.slice(i.start, i.end)).toBe(i.text);
        expect(inv.warnings).toContain('Flattened qualification boundaries are inferred; independent review required.');
    });
    it('never converts inventory completeness into independent attestation', () => {
        const report = buildExtractionCoverage({ rawJd: raw, jdHash: 'hash', structured: { requirements: [], constraints: [], responsibilities: [], alternativeGroups: [] } as never });
        expect(report.humanAttestation).toBe('ABSENT');
        expect(report.status).toBe('REVIEW');
        expect(report.sections.minimumQualifications.unresolvedCount).toBe(8);
    });
    it('preserves missing headings on the second frozen saved JD and does not invent years', () => {
        const ahead = readFileSync(new URL('../fixtures/ai-platform-engineer.jd.txt', import.meta.url), 'utf8');
        expect(inventorySource(ahead).warnings).toContain('No explicit qualification section found; completeness unresolved.');
        expect(extractExperienceThresholds(ahead)).toHaveLength(0);
    });
});
