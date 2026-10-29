import { describe, expect, test } from "vitest";
import { careerRank, selectLiveJobs } from "../../src/discovery/live-print/select.js";

const phrases = {
  sdet: ["SDET", "QA Automation Engineer", "Software Test Engineer"],
  security: ["SOC Analyst", "Security Engineer"],
  cloud: ["Cloud Security Engineer"],
  network: ["Network Engineer"],
};

describe("live job selection", () => {
  test("keeps a US security title and drops propulsion and a duplicate", () => {
    const jobs = selectLiveJobs([
      { provider: "greenhouse", company: "Stripe", title: "Security Engineer", location: "New York, NY", url: "https://stripe.com/jobs/1", requisitionId: "1", descriptionText: null },
      { provider: "greenhouse", company: "Stripe", title: "Security Engineer", location: "New York, NY", url: "https://stripe.com/jobs/1", requisitionId: "1", descriptionText: null },
      { provider: "greenhouse", company: "Stripe", title: "Propulsion Software Test Engineer", location: "Austin, TX", url: "https://stripe.com/jobs/2", requisitionId: "2", descriptionText: null },
      { provider: "ashby", company: "Notion", title: "SOC Analyst", location: "Bengaluru, India", url: "https://jobs.ashbyhq.com/notion/a", requisitionId: "a", descriptionText: null },
      { provider: "lever", company: "Spotify", title: "Network Engineer", location: "Remote", url: "https://jobs.lever.co/spotify/b", requisitionId: "b", descriptionText: null },
    ], phrases);
    expect(jobs.map((job) => job.requisitionId).sort()).toEqual(["1", "a", "b"]);
    expect(jobs.find((job) => job.requisitionId === "1")?.locationVerdict).toBe("US");
    expect(jobs.find((job) => job.requisitionId === "a")?.locationVerdict).toBe("NON_US");
    expect(jobs.find((job) => job.requisitionId === "b")?.locationVerdict).toBe("UNKNOWN");
  });

  test("ranks early-career titles ahead of senior titles", () => {
    expect(careerRank("Junior Security Engineer")).toBeLessThan(careerRank("Security Engineer"));
    expect(careerRank("Security Engineer")).toBeLessThan(careerRank("Senior Security Engineer"));
  });
});
