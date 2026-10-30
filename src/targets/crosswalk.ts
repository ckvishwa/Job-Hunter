import { readFileSync } from "node:fs";
import { parseCsv } from "./csv.js";

export interface TargetRecord {
  id: string;
  displayName: string;
  aliases: string[];
  parentCompany: string | null;
  existingFortune500RegistryMatch?: string | null;
  sponsorshipHistoryStatus: string;
  roleLevelSponsorshipStatus: string;
  officialCareerUrlVerifiedCurrent: boolean;
  atsIdentityVerifiedCurrent: boolean;
  employerIdentityNotes?: string;
  targetListMembership?: string[];
}

export interface MappingRow {
  inputName: string;
  canonicalDisplayName: string;
  canonicalId: string;
  alreadyIn68: boolean;
  notes: string;
}

export interface CrosswalkReport {
  ok: boolean;
  originalCount: number;
  mappingRows: number;
  mappingCanonicalIds: number;
  overlapCanonicalIds: number;
  addedCanonicalIds: number;
  mergedCount: number;
  expectedFormula: string;
  discrepancies: string[];
  identityChecks: { name: string; ok: boolean; detail: string }[];
}

function asRecords(parsed: unknown): TargetRecord[] {
  const records = parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)
    ? (parsed as { records: TargetRecord[] }).records
    : [];
  return records;
}

export function loadTargetRecords(filePath: string): TargetRecord[] {
  return asRecords(JSON.parse(readFileSync(filePath, "utf8")));
}

export function loadMapping(filePath: string): MappingRow[] {
  return parseCsv(readFileSync(filePath, "utf8")).map((row) => ({
    inputName: row.inputName ?? "",
    canonicalDisplayName: row.canonicalDisplayName ?? "",
    canonicalId: row.canonicalId ?? "",
    alreadyIn68: (row.alreadyIn68 ?? "").toLowerCase() === "true",
    notes: row.notes ?? "",
  }));
}

function hasId(records: TargetRecord[], id: string): TargetRecord | undefined {
  return records.find((record) => record.id === id);
}

export function validateCrosswalk(original: TargetRecord[], mapping: MappingRow[], merged: TargetRecord[]): CrosswalkReport {
  const discrepancies: string[] = [];
  const originalIds = original.map((record) => record.id);
  const mergedIds = merged.map((record) => record.id);
  const originalSet = new Set(originalIds);
  const mergedSet = new Set(mergedIds);
  if (originalSet.size !== original.length) discrepancies.push(`Original file has ${original.length - originalSet.size} duplicate ids.`);
  if (mergedSet.size !== merged.length) discrepancies.push(`Merged file has ${merged.length - mergedSet.size} duplicate ids.`);
  const mapIds = mapping.map((row) => row.canonicalId);
  const mapSet = new Set(mapIds);
  if (mapSet.size !== mapIds.length) discrepancies.push("Mapping file repeats a canonical id.");
  if (mapping.length !== 40) discrepancies.push(`Mapping file has ${mapping.length} rows; the supplied list was described as 40.`);
  if (original.length !== 68) discrepancies.push(`Original file has ${original.length} records; the supplied list was described as 68.`);

  const overlap = [...mapSet].filter((id) => originalSet.has(id));
  const added = [...mapSet].filter((id) => !originalSet.has(id));
  const formula = originalSet.size + added.length;
  if (mergedSet.size !== formula) {
    discrepancies.push(`Merged unique count ${mergedSet.size} does not equal original ${originalSet.size} plus new canonical ids ${added.length}.`);
  }
  if (overlap.length !== 25) {
    discrepancies.push(`Overlapping canonical ids are ${overlap.length}, not the stated 25.`);
  }
  for (const id of originalSet) {
    if (!mergedSet.has(id)) discrepancies.push(`Original id ${id} is missing from the merged watchlist.`);
  }
  for (const id of mapSet) {
    if (!mergedSet.has(id)) discrepancies.push(`Mapping canonical id ${id} is missing from the merged watchlist.`);
  }
  for (const id of mergedSet) {
    if (!originalSet.has(id) && !mapSet.has(id)) discrepancies.push(`Merged id ${id} is in neither the original 68 nor the 40-name mapping.`);
  }

  const markedOverlap = mapping.filter((row) => row.alreadyIn68).map((row) => row.canonicalId);
  const markedSet = new Set(markedOverlap);
  if (markedSet.size !== overlap.length || overlap.some((id) => !markedSet.has(id))) {
    discrepancies.push("alreadyIn68 flags do not match canonical-id overlap with the original 68.");
  }

  for (const record of merged) {
    if (record.sponsorshipHistoryStatus !== "USER_SUPPLIED_UNVERIFIED") {
      discrepancies.push(`${record.id} sponsorship history is ${record.sponsorshipHistoryStatus}; owner claims must stay unverified.`);
    }
    if (record.roleLevelSponsorshipStatus !== "UNKNOWN") {
      discrepancies.push(`${record.id} role-level sponsorship is ${record.roleLevelSponsorshipStatus}; list membership must not decide a posting.`);
    }
    if (record.atsIdentityVerifiedCurrent || record.officialCareerUrlVerifiedCurrent) {
      discrepancies.push(`${record.id} is marked currently verified inside the watchlist. Verification belongs in a separate checked source.`);
    }
  }

  const google = hasId(merged, "google");
  const wiz = hasId(merged, "wiz");
  const amazon = hasId(merged, "amazon-aws");
  const discover = hasId(merged, "discover-financial-services");
  const capitalOne = hasId(merged, "capital-one");
  const appscan = hasId(merged, "hclsoftware-appscan");
  const hcl = hasId(merged, "hcl-america");
  const synopsys = hasId(merged, "synopsys");
  const splunk = hasId(merged, "splunk");
  const linkedin = hasId(merged, "linkedin");
  const vmware = hasId(merged, "vmware-by-broadcom");
  const identityChecks = [
    check("Google and Mandiant stay one employer", Boolean(google) && !hasId(merged, "mandiant") && (google?.aliases ?? []).some((alias) => /mandiant/i.test(alias)), "Mandiant is a Google brand label, not a second canonical employer."),
    check("Wiz stays distinct from Google", Boolean(wiz) && wiz?.id !== google?.id, "Wiz requisitions are not collapsed into Google."),
    check("AWS stays on the Amazon record", Boolean(amazon) && !hasId(merged, "aws") && /amazon/i.test(amazon?.displayName ?? ""), "AWS is not a second employer."),
    check("Discover stays distinct from Capital One", Boolean(discover && capitalOne) && discover?.id !== capitalOne?.id, "Acquisition does not merge requisition identity."),
    check("HCL AppScan stays distinct from HCL America", Boolean(appscan && hcl) && appscan?.id !== hcl?.id && /product/i.test(appscan?.employerIdentityNotes ?? ""), "AppScan is a product label on its own search record."),
    check("Synopsys is not renamed to Black Duck", Boolean(synopsys) && !/black duck/i.test(synopsys?.id ?? "") && /black duck/i.test(synopsys?.employerIdentityNotes ?? ""), "Former Software Integrity assets are an expansion candidate, not an alias that replaces Synopsys."),
    check("Splunk stays distinct under Cisco", Boolean(splunk) && splunk?.parentCompany === "Cisco Systems" && splunk.id !== "cisco-systems", "Parent linkage does not drop the Splunk requisition identity."),
    check("LinkedIn stays distinct under Microsoft", Boolean(linkedin) && linkedin?.parentCompany === "Microsoft", "Parent linkage does not drop the LinkedIn requisition identity."),
    check("VMware stays distinct under Broadcom", Boolean(vmware) && vmware?.parentCompany === "Broadcom", "Parent linkage does not drop the VMware requisition identity."),
  ];
  for (const item of identityChecks) {
    if (!item.ok) discrepancies.push(`${item.name}: ${item.detail}`);
  }

  return {
    ok: discrepancies.length === 0,
    originalCount: originalSet.size,
    mappingRows: mapping.length,
    mappingCanonicalIds: mapSet.size,
    overlapCanonicalIds: overlap.length,
    addedCanonicalIds: added.length,
    mergedCount: mergedSet.size,
    expectedFormula: "68 original + 40 names - overlapping canonical ids = merged unique targets",
    discrepancies,
    identityChecks,
  };
}

function check(name: string, ok: boolean, detail: string): { name: string; ok: boolean; detail: string } {
  return { name, ok, detail };
}

export function validateCrosswalkFiles(originalPath: string, mappingPath: string, mergedPath: string): CrosswalkReport {
  return validateCrosswalk(loadTargetRecords(originalPath), loadMapping(mappingPath), loadTargetRecords(mergedPath));
}
