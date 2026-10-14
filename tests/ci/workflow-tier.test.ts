import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("tiered CI static contract", () => {
  it("rechecks when draft changes to ready for review", () => {
    expect(workflow).toContain("ready_for_review");
    expect(workflow).toContain("converted_to_draft");
  });

  it("runs a browser-free fast suite", () => {
    expect(workflow).toContain("name: Fast tests (browser-free)");
    expect(pkg.scripts["test:fast"]).toContain("vitest run");
    expect(pkg.scripts["test:fast"]).not.toMatch(/tests\/e2e|tests\/browser|tests\/pipeline\/offline-e2e|tests\/packet\/form-fill/);
  });

  it("only skips headed jobs for draft PRs", () => {
    expect(workflow.match(/if: \$\{\{ github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.draft == false \}\}/g)).toHaveLength(2);
    expect(workflow).toContain("run: npm test");
    expect(workflow).toContain("run: xvfb-run");
  });

  it("enforces headed checks for full CI gate", () => {
    expect(workflow).toContain("needs: [static, test-fast, test-linux, test-windows, secret-scan, dependency-audit]");
    expect(workflow).toContain('if [ "$r" != "success" ]; then echo "CI gate FAILED: required full headed test job did not succeed"');
    expect(workflow).toContain("FAST-ONLY PASS (draft PR)");
  });
  it("fails closed: the gate reads the PR's current draft state, not the stale event payload", () => {
    expect(workflow).toContain('gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq .draft');
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("cannot read current PR draft state");
    expect(workflow).not.toContain("DRAFT_PR: ${{ github.event_name == 'pull_request' && github.event.pull_request.draft }}");
  });
});
