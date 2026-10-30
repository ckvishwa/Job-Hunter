import { describe, expect, it } from "vitest";
import { deriveAlternatives } from "../../src/semantic/source-alternatives.js";

// Expected values are hand-read from the Sparksoft 5259170007 source items, not produced by the function.
const terms = (text: string) => {
  const d = deriveAlternatives(text);
  return d ? { args: (d.logic as { args: string[] }).args, openEnded: d.openEnded } : null;
};

describe("deriveAlternatives (deterministic, from the source item only)", () => {
  it("splits a 'such as' example list and drops an open-ended tail", () => {
    expect(terms("Some hands-on experience with test automation tools or frameworks such as Selenium, Playwright, Cucumber, TestNG, JUnit, or similar technologies.")).toEqual({
      args: ["Selenium", "Playwright", "Cucumber", "TestNG", "JUnit"],
      openEnded: true,
    });
    expect(terms("Exposure to containerized environments such as Docker or Kubernetes.")).toEqual({ args: ["Docker", "Kubernetes"], openEnded: false });
  });

  it("uses the innermost list when another OR appears earlier in the item", () => {
    expect(terms("Experience or working knowledge of API testing using tools such as ReadyAPI, SoapUI, Postman, RestAssured, or similar tools.")?.args).toEqual(["ReadyAPI", "SoapUI", "Postman", "RestAssured"]);
  });

  it("allows an AND in the shared lead-in but not inside the list", () => {
    expect(terms("Familiarity with source control, build, and CI/CD tools such as Git, Maven, Jenkins, or similar technologies.")?.args).toEqual(["Git", "Maven", "Jenkins"]);
    expect(terms("Knowledge of tools such as Git and Maven, or similar.")).toBeNull();
  });

  it("splits a comma list introduced by the nearest preposition and a short pair", () => {
    expect(terms("Approximately 1–3 years of experience in software testing, quality assurance, software development, or a related technical role.")?.args).toEqual(["software testing", "quality assurance", "software development"]);
    expect(terms("3+ years of software engineering with Go or Rust.")?.args).toEqual(["Go", "Rust"]);
    expect(terms("Experience with web apps and/or APIs.")?.args).toEqual(["web apps", "APIs"]);
  });

  it("refuses ambiguous or mixed clauses so they stay unresolved evidence", () => {
    for (const text of [
      "Hands-on experience with functional testing and test case development for web applications and/or APIs.",
      "Experience with Java or JavaScript development, including development of small applications, utilities, automation components, or scripts.",
      "Knowledge of AI-assisted development or testing tools and an interest in applying AI to software quality and test automation.",
      "Prior experience supporting healthcare, government, CMS, or other complex enterprise systems is a plus.",
      "Testing and design for web apps and/or APIs.",
    ]) expect(terms(text)).toBeNull();
  });

  it("returns null when there is no connector, and every returned term is a verbatim ordered slice", () => {
    expect(terms("Strong analytical, problem-solving, troubleshooting, and attention-to-detail skills.")).toBeNull();
    const text = "Basic to intermediate programming or scripting experience using Java, JavaScript, or a comparable programming language.";
    let at = 0;
    for (const term of terms(text)!.args) {
      at = text.indexOf(term, at);
      expect(at).toBeGreaterThanOrEqual(0);
      at += term.length;
    }
  });
});
