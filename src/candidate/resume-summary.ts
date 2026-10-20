/** A compact view of proposals from pasted text. Rejected facts are never shown as extracted details. */
export function summarizeResumeFacts(facts: ReadonlyArray<{ kind: string; value: string; approvalStatus: string }>): {
  name: string | null; phone: string | null; email: string | null; skills: string[];
} {
  const active = facts.filter((fact) => fact.approvalStatus !== "rejected");
  const first = (kind: string): string | null => active.find((fact) => fact.kind === kind)?.value ?? null;
  const skills: string[] = [];
  const seen = new Set<string>();
  for (const fact of active) {
    if (fact.kind !== "skill") continue;
    const key = fact.value.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    skills.push(fact.value);
  }
  return { name: first("legal_name"), phone: first("phone"), email: first("email"), skills };
}
