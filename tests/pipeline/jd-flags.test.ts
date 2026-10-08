import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeJd, splitSentences } from "../../src/pipeline/discovery/jd-flags.js";

// Expected quotes are the exact sentences of the saved public postings, read by hand.
const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures", name), "utf8");

describe("JD flags on saved postings", () => {
  it("Expel: no sponsorship (verbatim), no clearance, no CT exclusion; its 1-2 years is preferred so no required years", () => {
    const jd = fixture("expel-8588028002.jd.txt");
    const flags = analyzeJd(jd, { location: "Remote" });
    expect(flags.noSponsorship?.quote).toBe("We do not currently sponsor immigration visas.");
    expect(flags.clearanceRequired).toBeNull();
    expect(flags.remoteExcludesCt).toBeNull();
    expect(flags.yearsRequired).toBeNull();
    expect(jd).toContain(flags.noSponsorship!.quote);
  });

  it("Twilio: 3 years required, and the remote role cannot hire in CT (quote ends with the state list)", () => {
    const jd = fixture("twilio-7808464.jd.txt");
    const flags = analyzeJd(jd, { location: "Remote - US" });
    expect(flags.yearsRequired).toEqual({ years: 3, quote: "3+ years of experience in a GSOC working environment" });
    expect(flags.remoteExcludesCt?.quote).toMatch(/This role will be remote, but is not eligible to be hired in CA, CT, NJ, NY, PA, WA\.$/);
    expect(jd).toContain(flags.remoteExcludesCt!.quote);
    expect(flags.noSponsorship).toBeNull();
    expect(flags.clearanceRequired).toBeNull();
  });

  it("Sparksoft: Public Trust clearance (verbatim) and 1 year", () => {
    const flags = analyzeJd(fixture("sparksoft-5259170007.jd.txt"), { location: "Remote/Onsite if local to Maryland" });
    expect(flags.clearanceRequired?.quote).toBe("Candidates must be able to obtain and maintain a Public Trust clearance.");
    expect(flags.yearsRequired?.years).toBe(1);
    expect(flags.yearsRequired?.quote).toMatch(/^Approximately 1.3 years of experience in software testing/);
  });

  it("Stripe: the highest required years wins (5+ over 2+); preferred items never count", () => {
    const flags = analyzeJd(fixture("stripe-8142302.jd.txt"), { location: "US Remote" });
    expect(flags.yearsRequired).toEqual({ years: 5, quote: "5+ years experience in information technology or cyber security roles including incident response" });
    expect(flags.noSponsorship).toBeNull();
    expect(flags.clearanceRequired).toBeNull();
  });
});

describe("flag rules", () => {
  it("sponsorship: negated or unavailable sponsorship is flagged, offers and silence are not", () => {
    for (const s of [
      "We are unable to sponsor work visas for this role.",
      "Candidates must be authorized to work in the US without sponsorship.",
      "Visa sponsorship is not available for this position.",
      "This position does not offer sponsorship.",
    ]) expect(analyzeJd(`Intro text. ${s} More text.`).noSponsorship?.quote).toBe(s);
    for (const s of ["We offer visa sponsorship for qualified candidates.", "Sponsorship is available.", "We are a sponsor of the local robotics club."]) {
      expect(analyzeJd(`Intro text. ${s} More text.`).noSponsorship).toBeNull();
    }
  });

  it("clearance: required wording is flagged; negated, preferred and unrelated wording is not", () => {
    for (const s of ["Must hold an active TS/SCI clearance with polygraph.", "Candidates must be able to obtain a Public Trust.", "This role requires a Secret security clearance."]) {
      expect(analyzeJd(`Intro. ${s} More.`).clearanceRequired?.quote).toBe(s);
    }
    for (const s of ["No security clearance is required.", "Active Secret clearance is preferred.", "A clearance is a plus.", "Security clearance is not required for this role."]) {
      expect(analyzeJd(`Intro. ${s} More.`).clearanceRequired).toBeNull();
    }
  });

  it("years: lower bound of a range, number words, highest across items, and only experience statements", () => {
    const years = (body: string) => analyzeJd(`Requirements:\n- ${body}`).yearsRequired?.years ?? null;
    expect(years("3-5 years of experience with testing")).toBe(3);
    expect(years("Five years of relevant experience")).toBe(5);
    expect(analyzeJd("Requirements:\n- 2+ years experience in QA\n- 7+ years of experience leading teams").yearsRequired?.years).toBe(7);
    expect(years("Founded 20 years ago, we are growing fast")).toBeNull();
    expect(analyzeJd("Preferred qualifications:\n- 8+ years of experience in security").yearsRequired).toBeNull();
  });

  it("remote exclusion: needs a remote role, an exclusion cue and Connecticut in the list", () => {
    const flag = (s: string, location: string | null = "Remote") => analyzeJd(`Intro. ${s} More.`, { location }).remoteExcludesCt?.quote ?? null;
    expect(flag("This role will be remote, but we cannot hire in NY, CT or NJ.")).toBe("This role will be remote, but we cannot hire in NY, CT or NJ.");
    expect(flag("Remote candidates residing in Connecticut are not eligible.")).not.toBeNull();
    expect(flag("This role is remote but not eligible to be hired in CA, NY, WA.")).toBeNull(); // CT not listed
    expect(flag("Offices in Hartford, CT and Boston.")).toBeNull(); // no exclusion cue
    expect(flag("We cannot hire in CT.", "Boston, MA")).toBeNull(); // not a remote role
  });

  it("sentences are exact substrings of the text", () => {
    const text = "First sentence here. Second one follows! Is this third? Yes.";
    const parts = splitSentences(text);
    expect(parts).toEqual(["First sentence here.", "Second one follows!", "Is this third?", "Yes."]);
    for (const p of parts) expect(text).toContain(p);
  });
});

describe("flag precision (cases found in the first live run)", () => {
  it("sponsorship of an export licence is not visa sponsorship", () => {
    const s = "Please note that any offer of employment may be conditioned on your authorization to receive software or technology controlled under these U.S. export laws without sponsorship for an export license.";
    expect(analyzeJd("Intro text. " + s + " More text.").noSponsorship).toBeNull();
  });

  it("a flattened run-on sentence yields a window around the wording, not the whole run", () => {
    const filler = "US Base Pay Range $207,000 and up with equity and a full benefits package including health, dental, vision and a generous retirement plan for every employee ";
    const wording = "Applicants must have the legal right to work in the country where the position is based, without the need for visa sponsorship.";
    const quote = analyzeJd(filler + wording).noSponsorship!.quote;
    expect(quote).toContain("without the need for visa sponsorship.");
    expect(quote).not.toContain("US Base Pay Range");
    expect((filler + wording).includes(quote)).toBe(true);
  });

  it("years in a desirable-skills list do not count as required", () => {
    const jd = [
      "Requirements:",
      "- 2+ years of experience in quality assurance",
      "Desirable Skills, Knowledge, and Experience",
      "- 10+ years of experience in corporate law",
    ].join(String.fromCharCode(10));
    expect(analyzeJd(jd).yearsRequired?.years).toBe(2);
  });

  it("a preferred word elsewhere in a long run does not hide a clearance requirement", () => {
    const run = "Bonus points for Kubernetes experience and a love of whiteboards and long walks and great coffee and quiet mornings for deep work on hard problems for our customers " +
      "What We Require: Active US Security clearance or eligibility and willingness to obtain a US Security clearance.";
    expect(analyzeJd(run).clearanceRequired?.quote).toContain("Active US Security clearance");
  });
});
