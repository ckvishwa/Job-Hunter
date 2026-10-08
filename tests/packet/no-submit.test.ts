import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source-level invariant for the "never submit" rule. The behavioural proof (a fixture whose submit count stays 0 when
// Enter and the submit button are exercised) is in form-fill.e2e.test.ts; this guards against someone adding a code path.
const packetDir = path.resolve("src/packet");
const files = [...readdirSync(packetDir).filter((f) => f.endsWith(".ts")).map((f) => path.join(packetDir, f)), path.resolve("src/pipeline/application-form.ts")];
const lines = files.flatMap((f) => readFileSync(f, "utf8").split(/\r?\n/).map((text, i) => ({ file: path.basename(f), line: i + 1, text })));

describe("no code path can submit an application", () => {
  it("never presses a key, dispatches submit, or calls form.submit()/requestSubmit()", () => {
    const offenders = lines.filter((l) => /\.press\(|keyboard\.(press|down|type)|\.requestSubmit\(|\.submit\(\)|dispatchEvent\(\s*new Event\(["']submit/.test(l.text));
    expect(offenders).toEqual([]);
  });

  it("clicks only a dropdown field to open it or an option inside an open dropdown, never a button", () => {
    const clicks = lines.filter((l) => /\.click\(/.test(l.text) && !/^\s*(\/\/|\*)/.test(l.text));
    expect(clicks.map((l) => `${l.file}: ${l.text.trim()}`)).toEqual([
      "form-fill.ts: await locator.click();",
      "form-fill.ts: await options.nth(matching[0]!.i).click();",
    ]);
  });

  it("targets no selector that names a submit, apply, next or continue control", () => {
    const offenders = lines.filter((l) => /(getByRole|locator)\([^)]*(submit|apply|next|continue|send)/i.test(l.text) && !/button\[type=submit\], input\[type=submit\]|querySelectorAll|submitControls|button\[type=submit\],input\[type=submit\]/.test(l.text));
    expect(offenders.map((l) => `${l.file}:${l.line}`)).toEqual([]);
  });

  it("states SUBMITTED only from independent evidence that no code in this repository produces", () => {
    const setters = lines.filter((l) => /independentEvidence:\s*true/.test(l.text));
    expect(setters).toEqual([]);
  });
});
