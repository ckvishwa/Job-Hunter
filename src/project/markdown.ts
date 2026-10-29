// Splits repository Markdown into navigable sections. Output is plain text: nothing here produces HTML, and the browser renders
// every section body with text nodes only (web/src/lib/markdown-lite.ts).

export interface MdSection {
  id: string;
  level: number;
  /** Heading text without the leading #'s. */
  title: string;
  /** Leading section number such as "6.2" or "4A", when the heading starts with one. */
  number: string | null;
  parentId: string | null;
  /** Text between this heading and the next heading of any level. */
  body: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUMBER = /^(\d+(?:\.\d+)*[A-Za-z]?)(?:[.):]|\s)\s*/;

export function slug(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 60) || "section";
}

/** Heading lines inside fenced code blocks are not headings. */
function* lines(md: string): Generator<{ text: string; fenced: boolean }> {
  let fence: string | null = null;
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (m) {
      if (fence === null) fence = m[1]![0]!;
      else if (m[1]![0] === fence) fence = null;
      yield { text: raw, fenced: true };
      continue;
    }
    yield { text: raw, fenced: fence !== null };
  }
}

export function splitSections(md: string, minLevel = 1, maxLevel = 3): { intro: string; sections: MdSection[] } {
  const sections: MdSection[] = [];
  const used = new Map<string, number>();
  const stack: MdSection[] = [];
  const introLines: string[] = [];
  let current: { section: MdSection; body: string[] } | null = null;
  const flush = (): void => {
    if (current) current.section.body = current.body.join("\n").replace(/^\n+|\n+$/g, "");
  };
  for (const { text, fenced } of lines(md)) {
    const h = fenced ? null : HEADING.exec(text);
    if (h && h[1]!.length >= minLevel && h[1]!.length <= maxLevel) {
      flush();
      const level = h[1]!.length;
      const title = h[2]!.replace(/[*_`]/g, "").trim();
      const num = NUMBER.exec(title);
      const base = slug(num ? `s${num[1]}` : title);
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      const section: MdSection = { id: seen ? `${base}-${seen + 1}` : base, level, title, number: num ? num[1]! : null, parentId: stack.length ? stack[stack.length - 1]!.id : null, body: "" };
      stack.push(section);
      sections.push(section);
      current = { section, body: [] };
    } else if (current) current.body.push(text);
    else introLines.push(text);
  }
  flush();
  return { intro: introLines.join("\n").replace(/^\n+|\n+$/g, ""), sections };
}

export interface NotebookEntry {
  id: string;
  /** ISO date from the heading, when it starts with one. */
  date: string | null;
  title: string;
  body: string;
}

export function splitNotebook(md: string): { intro: string; entries: NotebookEntry[] } {
  const { intro, sections } = splitSections(md, 2, 2);
  const entries = sections.map((s, i) => {
    const date = /^(\d{4}-\d{2}-\d{2})\b/.exec(s.title);
    return { id: `entry-${i + 1}`, date: date ? date[1]! : null, title: s.title, body: s.body };
  });
  return { intro, entries };
}
