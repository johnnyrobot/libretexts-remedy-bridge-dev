# LT-116 reviewed writes: local integration contract

This is the first LT-113 release slice, not deployment approval. ADR-0001's
loopback-only listener, no tunnel/proxy exposure, integration feature flag and
owner sandbox allowlist still apply. No live library verification was performed.

## Callers

1. Request `/v1/cxone/page/preview-fix` (or `/api/preview` for the local panel).
2. Review the returned exact output and canonical target. Preserve the opaque
   `preview_token` and compatibility `preview_hash`; `/api/preview` uses
   `previewToken` and `previewHash`.
3. Apply that token/hash to the same page and mode. Pipeline tier, when supplied,
   must match. Changing page, tier, mode or output requires another preview.
   Revised image descriptions return a new token and consume the old token.
4. Treat tokens as single use. The claim occurs before awaited target reads.
   A validation/read/write failure after claiming also consumes the token.

Tokenless apply is now rejected with HTTP 409 `preview_required`. It cannot
regenerate reviewed AI output from a source hash. Existing callers must preserve
and forward the returned token; there is no compatibility bypass. The panel
clears its review on page/tier changes and consumes it when apply begins, clearing stale scan evidence as well. CLI fix/pipeline apply the output just shown and saved, without a second generation; CLI restore binds the reviewed source and snapshot hashes. CLI commands report audit failure and unknown outcomes with a recovery snapshot reference.

Canonical numeric page identity is re-resolved inside the writer. Supplied
ID/path/host disagreement fails before snapshot or mutation. HTML/tag writes and
restores share a process-local per-page lock. HTML source is re-read under the
lock; a stale source rejects with no mutation. Exact reviewed HTML is submitted
without an additional patch/serializer pass. Restore also checks that the chosen
snapshot output still matches its reviewed output hash.

## Outcomes and recovery

- HTTP 200 `applied:true`/`restored:true`, `write_outcome:"succeeded"` means CXone
  returned success. `audit_recorded:false` still means the write succeeded:
  preserve the returned snapshot/revision reference and repair/reconcile the
  local audit. Do not repeat the mutation to repair an audit failure.
- HTTP 409 `write_outcome_unknown`, `write_outcome:"unknown"`, `retry_safe:false`
  means the remote mutation may have succeeded. The token is consumed and that
  canonical page is quarantined for this process, including new previews and
  other mutation kinds. Preserve its saved snapshot and inspect CXone revision
  history before deciding any further action. No automatic mutation retry.
- A lost HTTP response is also ambiguous to the caller. Never infer that a
  network error means no write. Reconcile before a new attempt. Expired/consumed
  previews return 409; a stale page requires a new review after reconciliation.

**Current limits:** locks and unknown-outcome quarantine are in memory. Do not
restart to bypass a quarantine; automatic restart is not an outcome recovery
mechanism. Multi-process writers and durable replay/outcome recovery remain
release gates. Outside editors can still race between the final source read and
POST (`edittime:'now'`); conditional-edit protection is not claimed. Reverting
this code cannot undo a remote revision, and loses in-memory claims/quarantine:
reconcile in-flight/unknown writes and preserve snapshot/audit storage first.

## Evidence and remaining release gates

`npm run build`, `npm test`, and
`./node_modules/.bin/tsc -p packages/conductor-panel/tsconfig.json --noEmit`
verify the local slice. `bridge-routes.test.ts` runs the actual panel/HTTP/core
path with only CXone replaced by a synthetic SDK adapter; it proves changed
page/tier rejection, exact output, tokenless rejection, single-use claims,
distinct-token serialization, restore, audit failure and unknown-write handling.
The UI check uses JSDOM, not native Chromium or TestSprite. Tests use fake keys,
synthetic content and temporary storage; no live writes or real AI calls.

TestSprite cannot verify this bridge under the current no-tunnel/no-public-
exposure rule. The approved budget does not authorize changing that rule. Its
credit balance and project list were checked; no bridge project/run exists and
no credits were spent for this slice.

LT-113 and LT-111 remain open for the signed reviewer path, durable claims,
mixed-kind snapshot recovery, image network safeguards, concurrent axe evidence,
dependencies, bounded job lifetime, isolated Linux/container full-stack tests,
pinned compatible artifacts and reviewed storage/backup/upgrade/rollback handoff.
The LT-1 wire files in `docs/proposals/` are proposed for Chief approval only;
this PR implements no signer, forwarder or verifier.
