import type { StructuredJob } from "../domain/structured-job.js";
export type SourceSegment = {
    start: number;
    end: number;
    text: string;
};
export type SourceSection = "required" | "preferred" | "responsibility" | "work" | "unknown" | "context";
export type SourceItem = SourceSegment & {
    id: string;
    section: SourceSection;
    heading: string;
    boundary: "explicit" | "inferred";
    annotate: boolean;
};
export interface SourceInventory {
    version: "source-inventory@5";
    items: SourceItem[];
    warnings: string[];
}
export type CoverageItem = SourceSegment & {
    id: string;
    quote: string;
    status: "EXTRACTED" | "EXCLUDED" | "UNRESOLVED";
    exclusionReason: string | null;
};
const HEADINGS = /\b(?:Minimum (?:requirements|qualifications)|Basic qualifications|Required qualifications|Required (?:experience|expereince)|Essential skills|Requirements|Qualifications|Preferred qualifications|Preferred skills|Preferred experience|Nice to have|Bonus points|Education & Certifications|Responsibilities|What you(?:’|'| wi)ll (?:do|be doing)|What you will (?:do|be doing)|What you should have|Who you are|Who we are|Why [A-Z][\w&-]+|About (?:the team|the company|[A-Z][\w&-]*)|Hybrid work(?: at [A-Z][\w&-]*)?|In-office expectations|Working remotely(?: at [A-Z][\w&-]*)?|Work arrangements?|Work location|Location|The US base salary range|Compensation|Pay and benefits|Benefits|What we offer|Equal opportunity)\b/gi;
const QUAL_START = /(?<!\S)(?:Approximately\s+\d+|\d+(?:\s*[-–]\s*\d+)?(?:\.\d+)?\+?\s+years?\b|(?:(?:Deep|Strong|General|Additional|Demonstrated|Proven|Practical|Hands-on|Working|Prior) (?:experience|expertise|proficiency|knowledge|understanding|exposure|ability)|Experience|Expertise|Proficiency|Knowledge|Understanding|Exposure|Ability|Familiarity)\b|(?:An|The) ability\b|Hands-on\b|Some hands-on\b|Basic (?:scripting capability|to intermediate)\b|Academic\b|Jira for\b|Candidates must\b|Applicants must\b|High standards\b|Empathy\b|[A-Z][\w+./-]* system administration (?:knowledge|experience)\b)/g;
const RESP_START = /(?<!\S)(?:Contribute|Act as|Design|Collaborate|Operate|Drive|Manage|Identify|Build|Develop|Maintain|Implement|Support|Lead)\b/g;
const WORK = /\b(?:remote(?:ly)?|office|work from home|onsite|on-site|hybrid work|relocat\w*|resid\w*|lived in the United States|travel|sponsor\w*|visa|citizen\w*|clearance|work authorization)\b/i;
function segment(raw: string, start: number, end: number): SourceSegment | null {
    while (start < end && /\s/.test(raw[start]!))
        start++;
    while (end > start && /\s/.test(raw[end - 1]!))
        end--;
    return end > start ? { start, end, text: raw.slice(start, end) } : null;
}
function sectionOf(label: string): SourceSection {
    if (/^(?:minimum|basic|required|essential|requirements|what you should have)/i.test(label))
        return 'required';
    if (/^(?:preferred|nice to have|bonus)/i.test(label))
        return 'preferred';
    if (/^(?:responsibilities|what you)/i.test(label))
        return 'responsibility';
    if (/^(?:hybrid work|in-office|working remotely|work arrangement|work location|location)/i.test(label))
        return 'work';
    if (/^(?:qualifications|who you are)/i.test(label))
        return 'unknown';
    return 'context';
}
/** Source preservation is deterministic, not an attestation of item interpretation. Flattened
 * lists use general lexical boundaries and are explicitly marked inferred for review. */
export function inventorySource(raw: string): SourceInventory {
    const headings: Array<{ start: number; end: number; label: string }> = [];
    for (const m of raw.matchAll(HEADINGS)) {
        const start = m.index!;
        const prefix = raw.slice(0, start);
        const punctuation = Math.max(prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'), prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
        const afterBoundary = prefix.slice(punctuation + 1);
        const followsBareHeading = headings.length > 0 && raw.slice(headings[headings.length - 1]!.end, start).trim() === '';
        const followingText = raw.slice(start + m[0].length).trimStart();
        const inlineQualificationHeading = /^(?:Minimum (?:requirements|qualifications)|Basic qualifications|Required qualifications|Required (?:experience|expereince)|Preferred qualifications|Preferred skills|Preferred experience|Essential skills|Nice to have|Bonus points|What you should have)$/i.test(m[0])
            && /^(?:(?:[-*•▪]|\d+[.)])\s*|Approximately\s+\d+|\d+(?:\s*[-–]\s*\d+)?(?:\.\d+)?\+?\s+years?\b|Experience\b|Expertise\b|Proficiency\b|Knowledge\b|Understanding\b|Exposure\b|Ability\b|Familiarity\b|Academic\b|An ability\b|The ability\b|High standards\b|Deep expertise\b|Strong\b|Bachelor|Master|Doctoral|PhD\b)/i.test(followingText);
        const inlineWorkHeading = /^(?:Hybrid work(?: at [A-Z][\w&-]*)?|In-office expectations|Working remotely(?: at [A-Z][\w&-]*)?|Work arrangements?|Work location)$/i.test(m[0])
            && /^(?:This role|Office-assigned|Working remotely|Remote|In-office|Employees|Stripes|The role)\b/i.test(followingText);
        // A title-like word inside prose (for example, "Product Requirements Documents") is
        // not a section boundary. Flattened DOM headings are accepted at sentence/line starts,
        // or adjacent to another already-recognized bare heading ("Who we are About Stripe").
        if (afterBoundary.trim() !== '' && !followsBareHeading && !inlineQualificationHeading && !inlineWorkHeading) continue;
        headings.push({ start, end: start + m[0].length, label: m[0] });
    }
    for (const m of raw.matchAll(/^[ \t]*(?:minimum (?:requirements|qualifications)|required qualifications|requirements|qualifications|preferred qualifications|nice to have|responsibilities|work arrangements?)[ \t]*:?[ \t]*$/gim))
        if (!headings.some(h => h.start >= m.index! && h.start < m.index! + m[0].length))
            headings.push({ start: m.index!, end: m.index! + m[0].length, label: m[0].trim() });
    // Unknown standalone headings remain visible. Do not classify them from a guess.
    for (const m of raw.matchAll(/^[^\r\n]{1,70}:\s*$/gm))
        if (!/\b(?:should|must|can|will)\b/i.test(m[0]) && !headings.some(h => h.start >= m.index! && h.start < m.index! + m[0].length))
            headings.push({ start: m.index!, end: m.index! + m[0].trimEnd().length, label: m[0].trim() });
    headings.sort((a, b) => a.start - b.start);
    const items: SourceItem[] = [];
    const warnings: string[] = [];
    const ranges = [{ start: 0, end: 0, label: '' }, ...headings];
    for (let n = 0; n < ranges.length; n++) {
        const h = ranges[n]!;
        const end = ranges[n + 1]?.start ?? raw.length;
        let sec = h.label ? sectionOf(h.label) : 'unknown' as SourceSection;
        if (h.label.endsWith(':') && sec === 'context')
            sec = 'unknown';
        const region = segment(raw, h.end, end);
        if (!region)
            continue;
        const bullets = [...region.text.matchAll(/^(?:[ \t]*)(?:[-*•▪]|\d+[.)])[ \t]+/gm)];
        let starts: number[] = [];
        let explicit = false;
        if (bullets.length) {
            starts = bullets.map(m => region.start + m.index! + m[0].length);
            explicit = true;
        }
        else if (sec === 'required' || sec === 'preferred')
            starts = [region.start,
                ...[...region.text.matchAll(QUAL_START)].filter(m => {
                    const before = region.text.slice(0, m.index!).trimEnd();
                    return !/^\d/.test(m[0]) || !/\b(?:past|last|of)$/.test(before);
                }).map(m => region.start + m.index!),
                ...[...region.text.matchAll(/[.!?]\s+(?=[A-Z0-9])/g)].map(m => region.start + m.index! + m[0].length)];
        else if (sec === 'responsibility')
            starts = [...region.text.matchAll(RESP_START)].map(m => region.start + m.index!);
        else {
            starts = [region.start, ...[...region.text.matchAll(/[.!?](?=\s+[A-Z]|\s*$)/g)].map(m => region.start + m.index! + 1)];
        }
        if (!starts.length)
            starts = [region.start];
        if (starts[0]! > region.start && raw.slice(region.start, starts[0]).replace(/[:\s\-*•▪\d.)]/g, ''))
            starts.unshift(region.start);
        starts = [...new Set(starts)].sort((a, b) => a - b);
        for (let i = 0; i < starts.length; i++) {
            let itemEnd = starts[i + 1] ?? end;
            if (explicit && i + 1 < starts.length) {
                const next = bullets.find(m => region.start + m.index! + m[0].length === starts[i + 1]);
                if (next)
                    itemEnd = region.start + next.index!;
            }
            const s = segment(raw, starts[i]!, itemEnd);
            if (!s || !s.text.replace(/[:\s]/g, ''))
                continue;
            const section = WORK.test(s.text) && (!['required', 'preferred', 'responsibility'].includes(sec) || /^(?:Candidates must|Applicants must|This role|Employees|You must|Must be|Remote|Hybrid|On-site|Onsite)\b/i.test(s.text)) ? 'work' : sec;
            const id = 's' + s.start.toString(36);
            items.push({ ...s, id, section, heading: h.label, boundary: explicit ? 'explicit' : 'inferred', annotate: ['required', 'preferred'].includes(section) });
        }
    }
    if (items.some(i => i.boundary === 'inferred' && ['required', 'preferred'].includes(i.section)))
        warnings.push('Flattened qualification boundaries are inferred; independent review required.');
    if (!items.some(i => i.section === 'required' || i.section === 'preferred'))
        warnings.push('No explicit qualification section found; completeness unresolved.');
    return { version: 'source-inventory@5', items, warnings };
}
export interface QualificationSection {
    level: 'required' | 'preferred';
    label: string;
    segmentationComplete: boolean;
    items: Array<SourceSegment & {
        id: string;
    }>;
}
export function extractQualificationSections(raw: string): QualificationSection[] {
    const inv = inventorySource(raw);
    return (['required', 'preferred'] as const).flatMap(level => { const items = inv.items.filter(i => i.section === level); return items.length ? [{ level, label: level === 'required' ? 'Minimum requirements' : 'Preferred qualifications', segmentationComplete: items.every(i => i.boundary === 'explicit'), items }] : []; });
}
/** Compatibility name for existing callers; no employer-specific rules. */
export const extractStripeQualificationSections = extractQualificationSections;
export function extractWorkArrangementSourceSegments(raw: string): SourceSegment[] { return inventorySource(raw).items.filter(i => i.section === 'work'); }
export function extractExperienceThresholds(raw: string): Array<SourceSegment & {
    years: number;
}> { return extractQualificationSections(raw).flatMap(s => s.items.flatMap(i => { const m = /\b(\d+(?:\.\d+)?)(?:\s*[-–]\s*\d+(?:\.\d+)?)?\+?\s+years?\b/i.exec(i.text); return m ? [{ ...i, years: Number(m[1]) }] : []; })); }
export function extractAlternativeClauses(raw: string): SourceSegment[] { return extractQualificationSections(raw).flatMap(s => s.items.filter(i => /\b(?:or|and\/or)\b/i.test(i.text))); }
function contains(e: {
    start: number;
    end: number;
}, s: SourceSegment) { return e.start <= s.start && e.end >= s.end; }
export function buildExtractionCoverage(input: {
    rawJd: string;
    jdHash: string;
    structured: StructuredJob;
}) {
    const inv = inventorySource(input.rawJd);
    const job = input.structured;
    const count = (items: CoverageItem[]) => ({ sourceItemCount: items.length, extractedCount: items.filter(i => i.status === 'EXTRACTED').length, excludedCount: items.filter(i => i.status === 'EXCLUDED').length, unresolvedCount: items.filter(i => i.status === 'UNRESOLVED').length, items });
    const qualifications = (level: 'required' | 'preferred') => count(inv.items.filter(i => i.section === level).map(i => {
        const years = /\b(\d+)(?:\s*[-–]\s*\d+)?\+?\s+years?\b/i.exec(i.text);
        const matches = job.requirements.filter(r => r.level === level && r.evidence.some(e => contains(e, i)));
        const yearsOk = !years || matches.some(r => r.minimumYears === Number(years[1]) && r.scope.kind !== 'unspecified');
        return { ...i, quote: i.text, status: matches.length && yearsOk ? 'EXTRACTED' : 'UNRESOLVED', exclusionReason: null, level, ...(years ? { yearsStatus: yearsOk ? 'EXTRACTED' : 'UNRESOLVED' } : {}) } as CoverageItem;
    }));
    const experienceThresholds = extractExperienceThresholds(input.rawJd).map(i => { const matches = job.requirements.filter(r => r.minimumYears === i.years && r.scope.kind !== 'unspecified' && r.evidence.some(e => contains(e, i))); return { ...i, status: matches.length ? 'EXTRACTED' : 'UNRESOLVED', requirementIds: matches.map(r => r.id), scopeStatus: matches.some(r => r.scope.kind === 'role' || r.scope.kind === 'domain') ? 'ROLE_SCOPED' : 'UNRESOLVED' }; });
    const alternativeClauses = extractAlternativeClauses(input.rawJd).map(i => { const matches = job.requirements.filter(r => r.groupId && r.evidence.some(e => contains(e, i))); return { ...i, operator: 'any_of', status: matches.length >= 2 ? 'EXTRACTED' : 'UNRESOLVED', requirementIds: matches.map(r => r.id) }; });
    const workArrangement = count(inv.items.filter(i => i.section === 'work').map(i => ({ ...i, quote: i.text, status: job.constraints.some(c => c.status !== 'unknown' && c.evidence.some(e => contains(e, i))) ? 'EXTRACTED' : 'UNRESOLVED', exclusionReason: null })));
    return { schemaVersion: 1, jobId: job.jobId, jdHash: input.jdHash, status: 'REVIEW', parserValidation: 'VALID', humanAttestation: 'ABSENT', sectionSegmentationComplete: inv.warnings.length === 0, sections: { minimumQualifications: qualifications('required'), preferredQualifications: qualifications('preferred') }, experienceThresholds, alternativeClauses, workArrangement, inventory: inv, interpretationLimit: 'Evidence preservation does not establish modality, boolean semantics or coverage approval.' };
}
export type ExtractionCoverageReport = ReturnType<typeof buildExtractionCoverage>;
