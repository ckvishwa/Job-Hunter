# Known flaky tests

Record a test here only when it has failed without a code change and passed on rerun. Re-run the single file before treating a failure as real.

## Headed-Chrome loopback search flow

- **Test:** `visible search flow against a loopback careers site (headed Chrome) > types into the real search field, results change as it types, opens the first MATCH and saves the cleaned DOM-extracted posting`
- **File:** `tests/e2e/offline/browser-search.e2e.test.ts`
- **Seen:** once in a full `npm test` run on 2026-10-08 (947 passed, 1 failed; the failing test took about 5.2 s). The same file passed 18/18 when run alone (this test about 3.1 s), and the next full run passed 987/987.
- **Likely cause (unconfirmed):** timing under load. The suite starts headed Chrome while other test files run in parallel, and this is the first browser test in the file, so it pays the cold-start cost. No product defect was found.
- **What to do:** `npx vitest run tests/e2e/offline/browser-search.e2e.test.ts`. If it fails alone, treat it as a real failure. If it fails repeatedly in full runs, raise its timeout or serialize browser test files rather than ignoring it.
