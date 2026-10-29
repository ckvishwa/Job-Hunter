# Engineering progress ledger

Scores are given only for answers the founder actually wrote. Nothing here is self-awarded.

| Date | Level | Concept | Exercise (real code) | Score | Common mistake | Next practice |
|---|---|---|---|---|---|---|
| 2026-10-14 | 2 Testing | Telling a product bug from a transport error in a failing assertion | `tests/api/s1-api.test.ts` concurrent upload: `new Set(ids).size` was 2 | 5/10 | Invented an explanation (a "fallback ID") that the code does not contain; read `registerResume` only by name, not line by line. Correct: `ON CONFLICT DO NOTHING` then `SELECT`; a failed request has `resumeId === undefined`, which makes the Set size 2. Good: proposed asserting status codes | Retention question pending: what assertion makes the test fail if all six requests fail and return `undefined`? |

Mastery is not recorded for any concept yet (one answer is not enough).
