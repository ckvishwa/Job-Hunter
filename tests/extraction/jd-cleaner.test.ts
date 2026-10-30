import { describe, expect, it } from "vitest";
import { stripHtml, stripHtmlWithStructure, unescapeEscapedHtml } from "../../src/extraction/jd-cleaner.js";

it("preserves headings and list items from an official ATS JD", () => {
  const html = "<h2>Required Skills and Experience:</h2><ul><li>2+ years in production security pipelines</li><li>Python or Go</li></ul><h2>Preferred:</h2><ul><li>Cloud security</li></ul>";
  expect(stripHtmlWithStructure(html)).toBe("Required Skills and Experience:\n- 2+ years in production security pipelines\n- Python or Go\nPreferred:\n- Cloud security");
});

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello   <b>World</b></p>\n<div>!</div>")).toBe("Hello World !");
  });

  it("removes script and style contents entirely", () => {
    expect(stripHtml("<style>.a{color:red}</style><p>Text</p><script>evil()</script>")).toBe(
      "Text",
    );
  });

  it("decodes common entities", () => {
    expect(stripHtml("Salary:&nbsp;$100k")).toBe("Salary: $100k");
  });
});

describe("entity-escaped HTML (Greenhouse job endpoints)", () => {
  const escaped = "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;We&#39;re hiring &amp; growing.&lt;/p&gt;&lt;/div&gt;";

  it("stripHtml alone cannot see escaped markup, which is why it is unescaped first", () => {
    expect(stripHtml(escaped)).toContain("div");
  });

  it("unescapeEscapedHtml turns escaped markup into real markup so stripHtml yields clean text", () => {
    expect(stripHtml(unescapeEscapedHtml(escaped))).toBe("We're hiring & growing.");
  });

  it("leaves real markup and plain text untouched", () => {
    expect(unescapeEscapedHtml("<p>a &lt;b&gt; c</p>")).toBe("<p>a &lt;b&gt; c</p>");
    expect(unescapeEscapedHtml("plain text")).toBe("plain text");
  });

  it("decodes the typographic entities seen in live Greenhouse JDs (e.g. salary ranges)", () => {
    expect(stripHtml("<p>$140,000 &mdash; $348,000 USD &ndash; we&rsquo;re hiring&hellip;</p>")).toBe("$140,000 \u2014 $348,000 USD \u2013 we\u2019re hiring\u2026");
  });

  it("never turns a decoded entity into markup after stripping", () => {
    expect(stripHtml("<p>use &lt;script&gt; carefully</p>")).toBe("use <script> carefully");
  });
});
