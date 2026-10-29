# CXone conditional content edits: evidence and verification gate

Investigated 2026-10-29 with the Matt Pocock research workflow. Only public documentation was opened through the mounted browser; installed SDK files were read locally. No library/provider requests, credentials, live writes, tests or product changes.

## Finding

Official documentation describes a timestamp conditional save, but does **not establish revision compare-and-swap or protection against different revisions sharing a timestamp**. Strict outside-editor race protection remains blocked. `edittime` alone is insufficient: the documented default conflict policy overwrites content.

## Primary evidence

1. The current [API index](https://expert-help.nice.com/Integrations_and_Extending_Content/API) links its “API Calls guide” to the official [archived endpoint catalog](https://expert-help.nice.com/Internal/Product/Archive/API_Calls). Following its content-POST link reaches [pages/{pageid}/contents (POST)](https://expert-help.nice.com/Internal/Product/Archive/API_Calls/pages/pages_pageid_contents_POST), last updated February 20, 2024. This is official but archived documentation, with substantially older examples.
2. That POST page's query table defines `edittime` as the preceding revision's edit timestamp, formatted `yyyyMMddHHmmss`; `now` skips concurrency checking. It defines `abort` values `never`, `modified`, `exists`, defaulting to `never`. Its implementation notes say `abort=modified` prevents saving when the page changed after the supplied timestamp; `abort=never` permits overwriting without merging. Therefore a candidate conditional request requires **both** captured `edittime` and `abort=modified`.
3. The POST response schema includes edit status `success|conflict` and `page.base` / `page.overwritten`. Its notes describe a conflict response containing overwritten content when overwriting is allowed. **A conflict body does not alone prove no mutation.** Listed HTTP return codes are 200, 400, 403 and 404. The page does not identify the precise status/body for an aborted modified save; do not invent HTTP 409 or 412 behavior.
4. The official [aggregate page GET](https://expert-help.nice.com/Internal/Product/Archive/API_Calls/pages/pages%2F%2F%7Bpageid%7D_(GET)) exposes `date.edited` and shows revision metadata and a UTC, whole-second example. This establishes a candidate source for the server timestamp, not fractional precision or timestamp uniqueness. The [current Page resource](https://expert-help.nice.com/Integrations_and_Extending_Content/API/Core_Resources/Page) exposes revision metadata but demonstrates `edittime=now` only. Neither establishes an accepted expected-revision parameter or `If-Match` on content POST. Property etags described in the API index apply to properties; they cannot establish content protection.

No source inspected specifies atomicity, same-second handling, accepted fractional `edittime`, or a revision/ETag precondition for content POST. Indexed searches for official `If-Match` and edit-conflict documentation supplied no further primary evidence; absence from search is not proof of non-support.

## Installed SDK evidence observed before the LT-124 transport patch

Installed `node_modules/@libretexts/cxone-expert-node/package.json` reports **1.7.0**. Its README identifies it as LibreTexts' SDK, not maintained by CXone.

- `dist/types/pages.d.ts:269–290`: required string `edittime`, optional `abort: "never"|"modified"|"exists"`, response `"@status"?: "success"|"conflict"`; no content expected-revision field.
- `dist/index.mjs:2450–2456`: `postPageContents(id, body, reqArgs, funcArgs)` posts to `/pages/{id}/contents`, spreads request arguments into query params and returns `response.data`. It does not interpret conflict status. `prepare` at 2237–2239 forwards optional headers; this permits transporting a header but proves no server support.
- `dist/index.mjs:55–82,2195–2211`: HTTP failures become `ExpertError` with `status` and `responseData`; successful response headers/status are not returned by `postPageContents`.
- The installed method includes this repository's `tools/patch-cxone-utf8.mjs` changes: UTF-8 content type, redirect rejection and timeout. Those are transport controls, not conditional edits.
- `packages/core/src/write-page.ts:91–95` currently supplies `edittime:'now'` and no `abort`; `docs/release/lt-116-reviewed-writes.md` correctly disclaims outside-editor race protection.

## Recommended gate

LT-124 now holds production mutation unavailable in readiness and dispatch (503 `conditional_write_unproven`) and blocks production core/CLI authorization. No bypass flag exists. Keep this hold until a current vendor contract and authorized sandbox evidence establish an atomic precondition that distinguishes **every** intervening revision. A fresh read, content hash, local lock, durable dispatch record or post-write reread cannot prevent an outside writer changing content between read and POST. Timestamp gating may mitigate some conflicts but must not be labeled revision CAS. Never retry an ambiguous dispatched mutation. Explicit response validation and reconciliation are required before classifying an outcome.

## Later sandbox procedure for Johnny — not executed

1. Obtain authorization naming `<SANDBOX_HOST>`, `<EXACT_PAGE_ID>` and `<EXACT_PAGE_PATH>`, permitted trial count and cleanup. Use only synthetic content, an isolated test page and existing approved local credentials. Record server/deployment version and SDK/bridge commits. Preserve initial body, hashes, revision and raw server timestamps locally; redact auth from evidence.
2. Establish baseline revision A. Capture its content plus matching revision/timestamp; reconcile separately fetched metadata by revision. Submit distinct reviewed content with `abort=modified`, captured timestamp, canonical numeric ID and redirects disabled. Record HTTP status, sanitized body, returned revision, subsequent body/hash and revision history. This is the accepted control.
3. Capture A again, pause immediately before POST, and have an independent editor commit B. Submit A's candidate. Record rejected/accepted/ambiguous outcome plus history; rejection must leave B and its revision untouched. Do not equate HTTP success or `conflict` text with rejection.
4. Repeat with two distinct revisions whose **observed server timestamps are identical** at the accepted precision, using a bounded preauthorized trial count. Do not fabricate timestamps or use import behavior to simulate it. If no collision occurs, mark this case untested. Any stale overwrite fails the strict gate; passing finite trials still does not prove atomicity.
5. Repeat stale and same-timestamp trials for restore through the same write path. Test future revision/`If-Match` alternatives only after vendor documentation specifies them.
6. Cleanup only within the explicit authorization: reread and confirm the latest revision belongs to this trial, then restore the approved initial body as a new revision and verify it. Unexpected edits or uncertain outcomes stop cleanup for reconciliation. Preserve snapshots, sanitized results and revision IDs; never retry to resolve a lost response.
