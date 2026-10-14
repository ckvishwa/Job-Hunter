import type { MlRepo } from "./repo.js";
import { sufficiency, type BuiltDataset, type DatasetItem } from "./split.js";

/** Written only after a human explicitly confirms a blind review of the full JD. */
export const INDEPENDENT_REVIEW = "independent-full-jd@1";

/** Recompute admission from current immutable label IDs and current text, never cached manifest counts. */
export async function admissionIssues(repo: MlRepo, items: readonly DatasetItem[]): Promise<string[]> {
  const labels = new Map((await repo.allLabelRows()).map((l) => [l.id, l]));
  const origins = await repo.humanOrigins();
  const zero = () => ({ relevant: 0, irrelevant: 0, adjacent: 0, unsure: 0 });
  const counts: BuiltDataset["counts"] = { train: zero(), heldout: zero(), employers: { train: 0, heldout: 0 }, groups: { train: 0, heldout: 0 } };
  const employers = { train: new Set<string>(), heldout: new Set<string>() };
  const issues = new Set<string>();
  for (const item of items) {
    if (item.relevance !== "relevant" && item.relevance !== "irrelevant") continue;
    const posting = await repo.posting(item.postingId);
    if (!posting || posting.textSha256 !== item.textSha256) { issues.add("Dataset contains changed or missing posting text; create a fresh dataset."); continue; }
    const label = item.labelIds.map((id) => labels.get(id)).find((l) => l?.task === "relevance" && l.postingId === item.postingId && l.roleSlug === item.roleSlug && l.textSha256 === item.textSha256 && l.value === item.relevance);
    if (!label) { issues.add("Dataset label provenance does not match its rows."); continue; }
    if (item.split === "heldout" && (label.note !== INDEPENDENT_REVIEW || origins.get(label.id)?.llm !== false)) {
      issues.add("Held-out independence is unverified: blind full-description human verification is required."); continue;
    }
    counts[item.split][item.relevance]++;
    employers[item.split].add(item.company.toLowerCase());
  }
  counts.employers = { train: employers.train.size, heldout: employers.heldout.size };
  const sufficient = sufficiency(counts);
  if (!sufficient.ok) for (const reason of sufficient.reasons) issues.add(reason);
  return [...issues];
}
