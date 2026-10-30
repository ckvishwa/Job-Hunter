import { z } from 'zod';
import { REQUIREMENT_TYPES, REQUIREMENT_LEVELS, CONSTRAINT_TYPES, CONSTRAINT_STATUSES, type StructuredProposal } from '../domain/structured-job.js';
import type { SourceInventory, SourceItem } from './source-coverage.js';
import { deriveAlternatives } from './source-alternatives.js';
export type Logic = string | {
    op: 'any_of' | 'all_of';
    args: Logic[];
};
const logicSchema: z.ZodType<Logic> = z.lazy(() => z.union([z.string().min(1).max(200), z.object({ op: z.enum(['any_of', 'all_of']), args: z.array(logicSchema).min(2).max(12) }).strict()]));
const annotation = z.object({ sourceId: z.string(), kind: z.enum([...REQUIREMENT_TYPES, 'responsibility', 'constraint', 'unresolved', 'excluded']), level: z.enum(REQUIREMENT_LEVELS).optional(), minimumYears: z.number().positive().max(50).optional(), scope: z.enum(['role', 'tool', 'domain']).optional(), scopeValue: z.string().max(200).optional(), logic: logicSchema.optional(), constraintType: z.enum(CONSTRAINT_TYPES).optional(), constraintStatus: z.enum(CONSTRAINT_STATUSES).optional(), unresolvedReason: z.string().min(1).max(160).optional() }).strict();
export const annotationSchema = z.object({ version: z.literal(1), annotations: z.array(annotation).max(200) }).strict();
// Optional fields keep ordinary items small. All output still passes Zod, assembly and the
// unchanged production StructuredJob validator; this internal schema is not a new job contract.
export const ANNOTATION_JSON_SCHEMA = { type: 'object', additionalProperties: false, required: ['version', 'annotations'], properties: { version: { const: 1 }, annotations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sourceId', 'kind'], properties: { sourceId: { type: 'string' }, kind: { enum: [...REQUIREMENT_TYPES, 'responsibility', 'constraint', 'unresolved', 'excluded'] }, level: { enum: [...REQUIREMENT_LEVELS] }, minimumYears: { type: 'number' }, scope: { enum: ['role', 'tool', 'domain'] }, scopeValue: { type: 'string' }, constraintType: { enum: [...CONSTRAINT_TYPES] }, constraintStatus: { enum: [...CONSTRAINT_STATUSES] }, unresolvedReason: { type: 'string' } } } } } };
/** Exact, affirmative clearance requirement only ("Candidates must be able to obtain and maintain a Public Trust
 * clearance."). Negations, conditionals and anything else stay unresolved source evidence. */
const CLEARANCE_REQUIRED = /^(?:Candidates|Applicants|You) must (?:be able to )?(?:obtain|hold|have|possess|maintain)(?: and (?:maintain|hold))? an? [A-Za-z][A-Za-z -]{1,40} clearance\.?$/;
export function isExplicitClearanceRequirement(text: string): boolean {
    return CLEARANCE_REQUIRED.test(text.trim());
}
export class AnnotationValidationError extends Error {
    constructor(message: string) { super(message); this.name = 'AnnotationValidationError'; }
}
/** Only syntax obligations are derived here: an explicit years/OR cue requires the model to
 * annotate its scope/logic. This neither supplies alternative answers nor approves meaning. */
export function annotationRequestSchema(items: SourceItem[]) {
    const base = ANNOTATION_JSON_SCHEMA.properties.annotations.items;
    const branches = items.flatMap(item => {
        const properties = { ...base.properties, sourceId: { const: item.id }, unresolvedReason: { type: 'string', minLength: 1, maxLength: 100 } };
        const common = { ...base, properties };
        const years = /\b\d+(?:\.\d+)?\+?\s+years?\b/i.test(item.text);
        return [
            { ...common, required: [...base.required, ...(years ? ['minimumYears', 'scope'] : [])], properties: { ...properties, kind: { enum: ['skill', 'domain_knowledge', 'tool', 'language', 'platform', 'certification', 'degree', 'constraint', ...(years ? ['role_experience'] : [])] } } },
            { ...common, required: [...base.required, 'unresolvedReason'], properties: { ...properties, kind: { const: 'unresolved' } } },
            { ...common, required: [...base.required, 'unresolvedReason'], properties: { ...properties, kind: { const: 'excluded' } } },
        ];
    });
    return { ...ANNOTATION_JSON_SCHEMA, properties: { ...ANNOTATION_JSON_SCHEMA.properties, annotations: { type: 'array', minItems: items.length, maxItems: items.length, items: { anyOf: branches } } } };
}
function fail(message: string): never { throw new AnnotationValidationError(message); }
/** Bounded CNF lowering: (A AND B) OR C -> (A OR C) AND (B OR C).
 * Existing flat any_of groups are joined by AND in the deterministic engine. */
export function logicToCnf(logic: Logic, depth = 0): string[][] {
    if (depth > 5)
        fail('logic depth exceeds 5');
    if (typeof logic === 'string')
        return [[logic]];
    const parts = logic.args.map(a => logicToCnf(a, depth + 1));
    if (logic.op === 'all_of')
        return parts.flat();
    let result: string[][] = [[]];
    for (const part of parts) {
        if (result.length * part.length > 24)
            fail('boolean expansion exceeds 24 clauses');
        result = result.flatMap(left => part.map(right => [...new Set([...left, ...right])]));
    }
    return result;
}
function hasOperator(logic: Logic, op: 'any_of' | 'all_of'): boolean {
    return typeof logic !== 'string' && (logic.op === op || logic.args.some(child => hasOperator(child, op)));
}
function display(text: string): string {
    if (text.length <= 200)
        return text;
    let end = 197;
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!))
        end--;
    return text.slice(0, end) + '...';
}
function exactAlternativeTerms(source: string, terms: string[], sourceId: string): string[] {
    const occurs = (term: string) => source.includes(term);
    if (terms.every(occurs)) return terms;

    // Some models repeat a shared leading predicate in every alternative. Strip only a
    // source-leading, token-aligned common prefix, then require each remaining term to occur
    // exactly once in the original item. Assembly restores that shared context deterministically.
    const common = terms.reduce((prefix, term) => {
        let length = 0;
        while (length < prefix.length && length < term.length && prefix[length] === term[length]) length++;
        return prefix.slice(0, length);
    });
    const boundary = common.lastIndexOf(' ');
    const sharedPrefix = boundary >= 0 ? common.slice(0, boundary + 1) : '';
    const shortened = sharedPrefix.trim() && source.startsWith(sharedPrefix)
        ? terms.map(term => term.slice(sharedPrefix.length))
        : [];
    if (shortened.length === terms.length && shortened.every(term => term.length > 0 && occurs(term))) return shortened;
    const invalid = terms.find(term => !occurs(term)) ?? terms[0] ?? '';
    fail(`logic term "${display(invalid)}" is not a verbatim source term for ${sourceId}; do not repeat shared context`);
}
function orderedTermPositions(source: string, terms: string[], sourceId: string): Array<{ start: number; end: number }> {
    const occurrences = terms.map(term => {
        const found: Array<{ start: number; end: number }> = [];
        for (let start = source.indexOf(term); start >= 0; start = source.indexOf(term, start + 1)) found.push({ start, end: start + term.length });
        return found;
    });
    const solutions: Array<Array<{ start: number; end: number }>> = [];
    const visit = (index: number, priorEnd: number, chosen: Array<{ start: number; end: number }>) => {
        if (solutions.length > 1) return;
        if (index === terms.length) { solutions.push(chosen); return; }
        for (const candidate of occurrences[index]!) {
            if (candidate.start < priorEnd) continue;
            if (index > 0) {
                const gap = source.slice(priorEnd, candidate.start).replace(/\b(?:or|and|either|a|an|the)\b/gi, '');
                if (!/^[\s,;()/&]*$/.test(gap)) continue;
            }
            visit(index + 1, candidate.end, [...chosen, candidate]);
        }
    };
    visit(0, 0, []);
    if (solutions.length !== 1) fail(`${solutions.length === 0 ? 'no ordered source match' : 'ambiguous ordered source match'} for logic terms ${sourceId}`);
    return solutions[0]!;
}
function alignFlatConnector(source: string, logic: Logic): Logic {
    if (typeof logic === 'string' || !logic.args.every((arg): arg is string => typeof arg === 'string')) return logic;
    const connectors = [...source.matchAll(/\band\/or\b|\b(?:and|or)\b/gi)].map(match => match[0]!.toLowerCase());
    if (connectors.length === 0) return logic;
    const expected = connectors.every(value => value === 'or' || value === 'and/or')
        ? 'any_of'
        : connectors.every(value => value === 'and') ? 'all_of' : null;
    if (!expected || logic.op === expected) return logic;
    // A flat annotation does not express mixed/nested connectors. For a source item whose
    // explicit connectors are all the same, retain the source's connective semantics.
    return { ...logic, op: expected };
}
export function assembleAnnotations(raw: string, inventory: SourceInventory, output: unknown) {
    const parsed = annotationSchema.safeParse(output);
    if (!parsed.success)
        fail('annotation schema: ' + parsed.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ').slice(0, 1500));
    const seen = new Set<string>();
    const required = new Map(inventory.items.filter(i => i.annotate).map(i => [i.id, i]));
    const proposal: StructuredProposal & {
        responsibilities: NonNullable<StructuredProposal['responsibilities']>;
        constraints: NonNullable<StructuredProposal['constraints']>;
        alternativeGroups: NonNullable<StructuredProposal['alternativeGroups']>;
    } = { requirements: [], responsibilities: [], constraints: [], alternativeGroups: [] };
    const notes: Array<{
        sourceId: string;
        note: string;
    }> = [];
    const unresolved: Array<{
        sourceId: string;
        reason: string;
    }> = inventory.items.filter(i => i.section === 'unknown' || (i.section === 'work' && !isExplicitClearanceRequirement(i.text))).map(i => ({ sourceId: i.id, reason: 'Unclassified source retained; interpretation unresolved (deterministic inventory).' }));
    for (const item of inventory.items.filter(i => i.section === 'work' && isExplicitClearanceRequirement(i.text))) {
        if (raw.slice(item.start, item.end) !== item.text)
            fail('source evidence mismatch ' + item.id);
        proposal.constraints.push({ id: item.id + '-clearance', type: 'clearance', status: 'required', value: display(item.text), evidence: [{ quote: item.text, start: item.start, end: item.end }] });
    }
    for (const item of inventory.items.filter(i => i.section === 'responsibility'))
        proposal.responsibilities.push({ id: item.id, value: display(item.text), evidence: [{ quote: item.text, start: item.start, end: item.end }] });
    for (const a of parsed.data.annotations) {
        const item = required.get(a.sourceId);
        if (!item)
            fail('unknown source ID ' + a.sourceId);
        if (seen.has(a.sourceId))
            fail('duplicate source ID ' + a.sourceId);
        seen.add(a.sourceId);
        if (raw.slice(item.start, item.end) !== item.text)
            fail('source evidence mismatch ' + a.sourceId);
        let logic = a.logic ? alignFlatConnector(item.text, a.logic) : undefined;
        let derivedAlternatives = false;
        const evidence = [{ quote: item.text, start: item.start, end: item.end }];
        if (item.text.length > 2000)
            fail('source item exceeds evidence limit; split source explicitly');
        if (a.kind === 'unresolved' || a.kind === 'excluded') {
            if (!a.unresolvedReason)
                fail('unresolved/excluded item needs reason ' + a.sourceId);
            unresolved.push({ sourceId: a.sourceId, reason: a.kind + ': ' + a.unresolvedReason });
            continue;
        }
        if (a.kind === 'responsibility') {
            if (a.logic || a.minimumYears || a.constraintType)
                fail('unsupported responsibility fields');
            proposal.responsibilities.push({ id: a.sourceId, value: display(item.text), evidence });
            continue;
        }
        if (a.kind === 'constraint') {
            if (!a.constraintType || !a.constraintStatus || a.constraintStatus === 'unknown')
                fail('explicit constraint needs type/status; use unresolved for uncertain interpretations');
            if (a.logic || a.minimumYears)
                fail('unsupported constraint fields');
            // V1 cannot encode applicability/conditionals. Preserve evidence in the sidecar, never
            // turn a definition, conditional expectation or cost disclosure into a knockout.
            if (/\b(?:defined as|office-assigned|expectation|if |when |cost of relocat|encourage you)\b/i.test(item.text)) {
                unresolved.push({ sourceId: a.sourceId, reason: 'conditional or advisory constraint requires interpretation review' });
                continue;
            }
            proposal.constraints.push({ id: a.sourceId, type: a.constraintType, status: a.constraintStatus, value: display(item.text), evidence });
            continue;
        }
        if (a.constraintType || a.constraintStatus || a.unresolvedReason)
            fail('unsupported fields for requirement ' + a.sourceId);
        const level = a.level ?? (item.section === 'required' || item.section === 'preferred' ? item.section : 'unknown');
        if (['required', 'preferred'].includes(item.section) && level !== item.section)
            fail('modality disagrees with explicit section ' + a.sourceId);
        const threshold = /\b(\d+(?:\.\d+)?)(?:\s*[-–]\s*\d+(?:\.\d+)?)?\+?\s+years?\b/i.exec(item.text);
        if (a.minimumYears !== undefined && [...item.text.matchAll(/\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\+?\s+years?\b/gi)].length > 1)
            fail('multiple years clauses need separate scoped source items ' + a.sourceId);
        if (a.minimumYears !== undefined && (!threshold || Number(threshold[1]) !== a.minimumYears || !a.scope))
            fail('unsupported or unscoped years ' + a.sourceId);
        if (a.scopeValue && !item.text.includes(a.scopeValue))
            fail('scope is not source supported ' + a.sourceId);
        if (threshold && a.minimumYears === undefined)
            fail('explicit minimumYears and scope required for ' + a.sourceId);
        if (!logic && /\b(?:or|and\/or)\b/.test(item.text)) {
            // Alternatives come from the source text, never from model-typed terms. Anything not
            // confidently splittable stays as unresolved, source-backed evidence.
            const derived = deriveAlternatives(item.text);
            if (!derived) {
                unresolved.push({ sourceId: a.sourceId, reason: 'alternatives not deterministically splittable; source retained for review' });
                continue;
            }
            logic = derived.logic;
            derivedAlternatives = true;
            if (derived.openEnded)
                notes.push({ sourceId: a.sourceId, note: 'open_ended_examples: list ends with "or similar/comparable"; only named terms are matchable' });
        }
        const add = (value: string, id: string, groupId: string | null, years: number | null, type = a.kind as (typeof REQUIREMENT_TYPES)[number]) => proposal.requirements.push({ id, type, value: display(value), level, minimumYears: years, scope: years ? { kind: a.scope!, value: a.scopeValue ?? display(item.text) } : { kind: 'unspecified', value: null }, groupId, evidence });
        if (logic) {
            if (!/\b(?:or|and|and\/or)\b/.test(item.text))
                fail('logic lacks a source connector ' + a.sourceId);
            const clauses = logicToCnf(logic);
            const sourceUsesOr = /\b(?:or|and\/or)\b/i.test(item.text);
            const sourceUsesAnd = /\band\b(?!\/or)/i.test(item.text);
            if (!derivedAlternatives && sourceUsesAnd && sourceUsesOr && typeof logic !== 'string' && logic.args.every(arg => typeof arg === 'string'))
                fail('mixed connectors require nested logic or unresolved for ' + a.sourceId);
            const outputUsesAnyOf = hasOperator(logic, 'any_of');
            if (sourceUsesOr && !outputUsesAnyOf)
                fail('source connector requires any_of for ' + a.sourceId);
            if (!sourceUsesOr && outputUsesAnyOf)
                fail('source connector requires all_of for ' + a.sourceId);
            const sourceTerms = [...new Set(clauses.flat())];
            const terms = exactAlternativeTerms(item.text, sourceTerms, a.sourceId);
            const termMap = new Map(sourceTerms.map((term, index) => [term, terms[index]!]));
            const normalizedClauses = clauses.map(clause => clause.map(term => termMap.get(term)!));
            const positions = orderedTermPositions(item.text, terms, a.sourceId);
            for (const [index, term] of terms.entries()) {
                const { start, end } = positions[index]!;
                const before = item.text[start - 1] ?? '', after = item.text[start + term.length] ?? '';
                if (/[\p{L}\p{N}_]/u.test(before) || /[\p{L}\p{N}_]/u.test(after))
                    fail('logic term is only a word fragment ' + a.sourceId);
            }
            const first = Math.min(...positions.map(p => p.start)), last = Math.max(...positions.map(p => p.end));
            const ordered = [...positions].sort((a, b) => a.start - b.start);
            for (let i = 1; i < ordered.length; i++) {
                const gap = item.text.slice(ordered[i - 1]!.end, ordered[i]!.start)
                    .replace(/\b(?:or|and|either|a|an|the)\b/gi, '');
                if (!/^[\s,;()/&]*$/.test(gap))
                    fail('unrepresented qualifier inside alternative ' + a.sourceId);
            }
            // Retain shared predicates/qualifiers; a platform mention must not replace knowledge of
            // that platform's internals, nor should a bare tool satisfy a scoped years clause.
            const prefix = item.text.slice(0, first).replace(/[ (]+$/, '').trim();
            const suffix = derivedAlternatives ? '' : item.text.slice(last).replace(/^[ )]+/, '').replace(/[.!?]+$/, '').trim();
            const contextual = (term: string) => [prefix, term, suffix].filter(Boolean).join(' ');
            normalizedClauses.forEach((terms, index) => {
                const unique = [...new Set(terms)];
                if (unique.length !== terms.length)
                    fail('duplicate logic term');
                const g = unique.length > 1 ? a.sourceId + '-g' + index : null;
                if (g)
                    proposal.alternativeGroups.push({ id: g, operator: 'any_of' });
                unique.forEach((term, j) => add(contextual(term), a.sourceId + '-' + index + '-' + j, g, a.minimumYears ?? null, a.minimumYears !== undefined && a.scope === 'role' ? 'role_experience' : a.kind as (typeof REQUIREMENT_TYPES)[number]));
            });
        }
        else {
            if (a.scope === 'tool' && !a.scopeValue)
                fail('tool scope needs an exact named tool');
            add(a.scope === 'tool' ? a.scopeValue! : item.text, a.sourceId, null, a.minimumYears ?? null);
        }
    }
    for (const id of required.keys())
        if (!seen.has(id))
            fail('omitted source ID ' + id);
    return { proposal, unresolved, notes, annotations: parsed.data, inventory };
}
