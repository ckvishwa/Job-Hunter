import { describe, expect, it } from "vitest";
import { BoardError } from "../../../src/pipeline/discovery/board-discoverer.js";
import { classifyBoardFailure, confirmOwnership, liveBoardConfigSchema, pageLinksToBoard, selectBatches, type LiveBoard } from "../../../src/discovery/live-print/boards.js";

const gh: LiveBoard = { company: "Acme Corp", ats: "greenhouse", board: "acme", employerCareersUrl: "https://acme.example/careers" };
const lever: LiveBoard = { company: "Acme Corp", ats: "lever", board: "acme", employerCareersUrl: "https://acme.example/careers" };
const reply = (map: Record<string, { status: number; body: string }>): typeof fetch =>
  (async (input: RequestInfo | URL) => { const hit = map[String(input)]; return hit ? new Response(hit.body, { status: hit.status }) : new Response("", { status: 404 }); }) as typeof fetch;

describe("pageLinksToBoard", () => {
  it("matches the exact board token on the provider host only", () => {
    expect(pageLinksToBoard('<a href="https://boards.greenhouse.io/acme/jobs/1">', "greenhouse", "acme")).toBe(true);
    expect(pageLinksToBoard('<a href="https://boards.greenhouse.io/acmeevil">', "greenhouse", "acme")).toBe(false);
    expect(pageLinksToBoard('<a href="https://evil.example/boards.greenhouse.io-acme">', "greenhouse", "acme")).toBe(false);
    expect(pageLinksToBoard('<a href="https://jobs.lever.co/acme">', "lever", "acme")).toBe(true);
    expect(pageLinksToBoard('<a href="https://jobs.lever.co/acme">', "greenhouse", "acme")).toBe(false);
  });
});

describe("confirmOwnership", () => {
  it("confirms a Greenhouse board by matching board name", async () => {
    const f = reply({ "https://boards-api.greenhouse.io/v1/boards/acme": { status: 200, body: JSON.stringify({ name: "Acme Corp" }) } });
    expect((await confirmOwnership(gh, f)).method).toBe("greenhouse-board-name");
  });
  it("rejects a mapping whose board belongs to a different organization", async () => {
    const f = reply({ "https://boards-api.greenhouse.io/v1/boards/acme": { status: 200, body: JSON.stringify({ name: "Totally Other Inc" }) },
      "https://acme.example/careers": { status: 200, body: "<html>no board links</html>" } });
    expect((await confirmOwnership(gh, f)).status).toBe("UNCONFIRMED");
  });
  it("confirms a Lever board only through the employer careers page link", async () => {
    const yes = reply({ "https://acme.example/careers": { status: 200, body: '<a href="https://jobs.lever.co/acme">Jobs</a>' } });
    expect((await confirmOwnership(lever, yes)).method).toBe("careers-page-link");
    expect((await confirmOwnership(lever, reply({}))).status).toBe("UNCONFIRMED");
  });
  it("honors a recorded manual ownership note", async () => {
    const r = await confirmOwnership({ ...lever, manualOwnershipNote: "checked official careers page by hand" }, reply({}));
    expect(r).toMatchObject({ status: "CONFIRMED", method: "manual-careers-page" });
  });
});

describe("classifyBoardFailure", () => {
  it("separates invalid token, rate limit, unreachable and parse failures", () => {
    expect(classifyBoardFailure(new BoardError("BOARD_NOT_FOUND", "x")).kind).toBe("INVALID_TOKEN");
    expect(classifyBoardFailure(new BoardError("BOARD_FETCH_FAILED", "Board API answered HTTP 429.")).kind).toBe("RATE_LIMITED");
    expect(classifyBoardFailure(new BoardError("BOARD_FETCH_FAILED", "Board request timed out or was cancelled.")).kind).toBe("UNREACHABLE");
    expect(classifyBoardFailure(new BoardError("BOARD_RESPONSE_INVALID", "bad")).kind).toBe("PARSE_FAILURE");
  });
});

describe("config", () => {
  it("rejects duplicate boards and unknown batches", () => {
    const dup = { version: 1, batches: [{ name: "a", companies: [gh, gh] }] };
    expect(liveBoardConfigSchema.safeParse(dup).success).toBe(false);
    const cfg = liveBoardConfigSchema.parse({ version: 1, batches: [{ name: "a", companies: [gh] }, { name: "b", companies: [lever] }] });
    expect(() => selectBatches(cfg, ["zzz"], 10)).toThrow(/Unknown batch/);
    expect(selectBatches(cfg, null, 10)).toHaveLength(2);
    expect(selectBatches(cfg, null, 1)).toHaveLength(1);
  });
});
