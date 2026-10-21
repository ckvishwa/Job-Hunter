import { workdayFromUrl } from "../ats/employer-resolution.js";
import { assertFetchableUrl } from "../security/url-guard.js";

export type AtsHintKind = "greenhouse" | "lever" | "ashby" | "workday";

export interface AtsHint {
  kind: AtsHintKind;
  board: string | null;
  evidenceUrl: string;
  workday: { tenant: string; instance: string; site: string; hostname: string } | null;
}

const PATTERNS: Array<{ kind: Exclude<AtsHintKind, "workday">; expression: RegExp }> = [
  { kind: "greenhouse", expression: /https?:\/\/(?:job-boards(?:\.eu)?|boards(?:\.eu)?)\.greenhouse\.io\/([A-Za-z0-9_-]{1,64})\b/gi },
  { kind: "greenhouse", expression: /https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]{1,64})\b/gi },
  { kind: "greenhouse", expression: /https?:\/\/(?:job-boards(?:\.eu)?|boards(?:\.eu)?)\.greenhouse\.io\/embed\/job_board\?[^"'<\s]*\bfor=([A-Za-z0-9_-]{1,64})\b/gi },
  { kind: "lever", expression: /https?:\/\/jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9_-]{1,64})\b/gi },
  { kind: "ashby", expression: /https?:\/\/jobs\.ashbyhq\.com\/([A-Za-z0-9-]{1,80})\b/gi },
];

function safeHttps(value: string): string | null {
  try {
    return assertFetchableUrl(value).toString();
  } catch {
    return null;
  }
}

/** Tokens and Workday coordinates that appear in a fetched page. Nothing is guessed from a company name. */
export function extractAtsHints(html: string, pageUrl: string): AtsHint[] {
  const text = html.replaceAll("\\/", "/");
  const hints: AtsHint[] = [];
  const seen = new Set<string>();
  const push = (hint: AtsHint) => {
    const key = `${hint.kind}:${hint.board ?? hint.workday?.hostname ?? ""}:${hint.workday?.site ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push(hint);
  };

  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      const board = match[1];
      const evidence = safeHttps(match[0].replace(/&amp;/g, "&"));
      if (!board || board === "embed" || !evidence) continue;
      push({ kind: pattern.kind, board, evidenceUrl: evidence, workday: null });
    }
  }

  const urls = new Set<string>([pageUrl]);
  for (const match of text.matchAll(/https?:\/\/[^"'<\s]+/gi)) urls.add(match[0].replace(/&amp;/g, "&"));
  for (const raw of urls) {
    const safe = safeHttps(raw);
    if (!safe) continue;
    const coords = workdayFromUrl(safe);
    if (!coords) continue;
    push({ kind: "workday", board: coords.tenant, evidenceUrl: safe, workday: coords });
  }
  return hints;
}
