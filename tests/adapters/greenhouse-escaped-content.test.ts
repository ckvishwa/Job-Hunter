import { describe, expect, it } from "vitest";
import { greenhouseAdapter } from "../../src/adapters/greenhouse.js";

// Observed live (Figma board, 2026-10-07): Greenhouse's job endpoints return `content` as
// entity-escaped HTML. The JD must come out as clean text, not "&lt;div class=&quot;...".
describe("greenhouse fetchJobDetails with entity-escaped content", () => {
  it("produces clean descriptionText and real-markup descriptionHtml", async () => {
    const details = await greenhouseAdapter.fetchJobDetails(
      {
        externalId: "1",
        title: "Security Engineer",
        url: "https://boards.greenhouse.io/acme/jobs/1?gh_jid=1",
        matchedProfiles: [],
        rawMetadata: {
          id: 1,
          title: "Security Engineer",
          content: "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;We&#39;re hiring &amp; growing.&lt;/p&gt;&lt;/div&gt;",
        },
      },
      {} as never,
      {} as never,
    );
    expect(details.descriptionText).toBe("We're hiring & growing.");
    expect(details.descriptionHtml).toContain("<p>");
    expect(details.descriptionText).not.toContain("&lt;");
  });
});
