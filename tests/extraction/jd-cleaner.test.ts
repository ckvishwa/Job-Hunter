import { describe, expect, it } from "vitest";
import { stripHtml } from "../../src/extraction/jd-cleaner.js";

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
