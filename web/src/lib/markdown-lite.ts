// A deliberately small, safe Markdown renderer for repository documents (PRD, engineering notebook).
//
// Safety model: the parser produces a typed tree (parseMarkdown / parseInline) and the DOM builder creates elements itself and
// sets text only through textContent / text nodes. Raw HTML in the source is never interpreted: it is displayed as literal text.
// Links are created only for http(s) URLs (with rel="noopener noreferrer"); javascript:, data:, vbscript: and every other scheme
// are shown as plain text. innerHTML, outerHTML and insertAdjacentHTML are never used in this file.

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] };

export type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "list"; ordered: boolean; items: string[] }
  | { t: "code"; text: string }
  | { t: "quote"; text: string }
  | { t: "table"; header: string[]; rows: string[][] }
  | { t: "hr" };

export function isSafeHref(href: string): boolean {
  try {
    const u = new URL(href);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ t: "text", text: buf });
    buf = "";
  };
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush(); out.push({ t: "code", text: m[1]! }); i += m[0].length;
    } else if ((m = /^\*\*([^*\n]+?)\*\*/.exec(rest))) {
      flush(); out.push({ t: "strong", children: parseInline(m[1]!) }); i += m[0].length;
    } else if ((m = /^\*([^*\s][^*\n]*?)\*/.exec(rest)) || (m = /^_([^_\s][^_\n]*?)_(?![A-Za-z0-9])/.exec(rest))) {
      flush(); out.push({ t: "em", children: parseInline(m[1]!) }); i += m[0].length;
    } else if ((m = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(rest))) {
      flush();
      if (isSafeHref(m[2]!)) out.push({ t: "link", href: m[2]!, children: parseInline(m[1]!) });
      else out.push({ t: "text", text: `${m[1]!} (${m[2]!})` }); // an unsafe or relative target is shown, never linked
      i += m[0].length;
    } else {
      buf += src[i]!;
      i += 1;
    }
  }
  flush();
  return out;
}

const splitRow = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i += 1; continue; }
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith(fence[1]!)) { body.push(lines[i]!); i += 1; }
      i += 1;
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { blocks.push({ t: "h", level: h[1]!.length, text: h[2]! }); i += 1; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ t: "hr" }); i += 1; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) { rows.push(splitRow(lines[i]!)); i += 1; }
      blocks.push({ t: "table", header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) { body.push(lines[i]!.replace(/^\s*>\s?/, "")); i += 1; }
      blocks.push({ t: "quote", text: body.join(" ") });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m) { items.push(m[2]!); i += 1; }
        else if (/^\s{2,}\S/.test(lines[i]!) && items.length) { items[items.length - 1] += ` ${lines[i]!.trim()}`; i += 1; }
        else break;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s{0,3}(`{3,}|~{3,})|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]!)) { para.push(lines[i]!.trim()); i += 1; }
    if (para.length === 0) { para.push(line.trim()); i += 1; }
    blocks.push({ t: "p", text: para.join(" ") });
  }
  return blocks;
}

// --- DOM -------------------------------------------------------------------------------------------------------------------

function textWithMarks(parent: Node, text: string, needle: string): void {
  if (!needle) { parent.appendChild(document.createTextNode(text)); return; }
  const lower = text.toLowerCase();
  let at = 0;
  for (;;) {
    const hit = lower.indexOf(needle, at);
    if (hit < 0) break;
    if (hit > at) parent.appendChild(document.createTextNode(text.slice(at, hit)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(hit, hit + needle.length);
    parent.appendChild(mark);
    at = hit + needle.length;
  }
  if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
}

function inlineTo(parent: Node, nodes: Inline[], needle: string): void {
  for (const n of nodes) {
    if (n.t === "text") textWithMarks(parent, n.text, needle);
    else if (n.t === "code") { const c = document.createElement("code"); textWithMarks(c, n.text, needle); parent.appendChild(c); }
    else if (n.t === "strong") { const s = document.createElement("strong"); inlineTo(s, n.children, needle); parent.appendChild(s); }
    else if (n.t === "em") { const e = document.createElement("em"); inlineTo(e, n.children, needle); parent.appendChild(e); }
    else {
      const a = document.createElement("a");
      a.setAttribute("href", n.href);
      a.setAttribute("rel", "noopener noreferrer");
      a.setAttribute("target", "_blank");
      inlineTo(a, n.children, needle);
      parent.appendChild(a);
    }
  }
}

/** Renders Markdown into a fragment of safe elements. `highlight` marks case-insensitive matches of a plain-text query. */
export function renderMarkdown(md: string, options: { highlight?: string; headingOffset?: number } = {}): DocumentFragment {
  const needle = (options.highlight ?? "").trim().toLowerCase();
  const offset = options.headingOffset ?? 0;
  const frag = document.createDocumentFragment();
  for (const b of parseMarkdown(md)) {
    if (b.t === "h") {
      const el = document.createElement(`h${Math.min(6, Math.max(3, b.level + offset))}`);
      inlineTo(el, parseInline(b.text), needle);
      frag.appendChild(el);
    } else if (b.t === "p") {
      const el = document.createElement("p");
      inlineTo(el, parseInline(b.text), needle);
      frag.appendChild(el);
    } else if (b.t === "list") {
      const el = document.createElement(b.ordered ? "ol" : "ul");
      for (const item of b.items) { const li = document.createElement("li"); inlineTo(li, parseInline(item), needle); el.appendChild(li); }
      frag.appendChild(el);
    } else if (b.t === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      textWithMarks(code, b.text, needle);
      pre.appendChild(code);
      pre.tabIndex = 0; // keyboard-scrollable
      frag.appendChild(pre);
    } else if (b.t === "quote") {
      const el = document.createElement("blockquote");
      inlineTo(el, parseInline(b.text), needle);
      frag.appendChild(el);
    } else if (b.t === "table") {
      const wrap = document.createElement("div");
      wrap.className = "md-table";
      wrap.tabIndex = 0;
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const c of b.header) { const th = document.createElement("th"); th.setAttribute("scope", "col"); inlineTo(th, parseInline(c), needle); hr.appendChild(th); }
      head.appendChild(hr);
      const body = document.createElement("tbody");
      for (const r of b.rows) { const tr = document.createElement("tr"); for (const c of r) { const td = document.createElement("td"); inlineTo(td, parseInline(c), needle); tr.appendChild(td); } body.appendChild(tr); }
      table.append(head, body);
      wrap.appendChild(table);
      frag.appendChild(wrap);
    } else {
      frag.appendChild(document.createElement("hr"));
    }
  }
  return frag;
}
