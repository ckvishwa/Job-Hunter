const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  middot: "\u00b7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
};

// Decoded AFTER tags are removed, so a decoded "<" can never be mistaken for markup.
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export function stripHtml(html: string): string {
  const withoutTags = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

/**
 * Some ATS APIs (Greenhouse's job endpoints) return the description as entity-escaped HTML
 * ("&lt;p&gt;..."). That is markup in disguise: stripHtml alone would keep it as literal text.
 * Real markup is left untouched; only content that is escaped and has no real tags is decoded.
 */
export function unescapeEscapedHtml(content: string): string {
  if (/<\/?[a-z][^>]*>/i.test(content) || !/&lt;\/?[a-z]/i.test(content)) return content;
  return decodeEntities(content);
}
