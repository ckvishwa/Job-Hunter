# Candidate fact review (V1)

Keep the reviewed profile, decision files, packets, and generated resumes under `private-runtime/`. The reviewer opens the private profile to see full wording; the packet redacts values and lists fact IDs, provenance, approval state, an unrated confidence label, and usage restrictions. Imported resume content is pending until each claim is individually reviewed.

```sh
npm run candidate:review -- --profile private-runtime/candidate/candidate-profile.reviewed-2.json --packet private-runtime/candidate/review-packet.json
```

To record one decision, create a private JSON file with `factId`, `action` (`approve`, `reject`, or `edit`), `reviewer`, and `reviewedAt` (`YYYY-MM-DD`). An edit also needs `value`. Then run:

```sh
npm run candidate:review -- --profile private-runtime/candidate/candidate-profile.reviewed-2.json --decision private-runtime/candidate/one-decision.json --out private-runtime/candidate/candidate-profile.next.json
```

The command refuses to overwrite output. An edit resets approval to pending. A new approval binds a digest to the exact claim and source; changing either makes it unusable. Legacy approvals without a claim digest remain protected by the canonical registry's whole-file hash and should be individually reaffirmed when reviewed. After human decisions, update the private canonical resume registry to the new profile path and hash through a separate review; the pipeline refuses an unregistered profile.

Work authorization, present and future sponsorship, clearance, legal eligibility, residence history, and employer-specific declarations require direct answers from the candidate. They are not inferred from other facts. A missing required answer keeps the job or form in review. The resume renderer takes current approved facts from the parsed profile and excludes sensitive and inspection-track claims.
