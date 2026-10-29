# CXone review profile contract — cxone-review-v1 (LT-174)

This is an optional non-writing rollout mode of the full Remedy Bridge
(`libretexts-remedy-bridge`) integration, which provides CXone Expert textbook
page I/O. Signed apply/restore/recovery remain in the same maintained build;
LibreTexts chooses rollout timing and whether to select this mode.
An engine/Scanner-only deployment omits Bridge entirely and needs no CXone
configuration. Server/Conductor owners consume this contract under LT-175/176;
this repo does not enable or certify those integrations or deployment readiness.

## Selection and configuration

`REMEDY_BRIDGE_PROFILE=review-only` selects the supported profile in every
runtime, including development/test. Omitted profile preserves `full-write`;
only those two exact values are accepted. Selection of review-only is latched
for the process: changing NODE_ENV, the variable or per-call env options cannot
reopen writes. Restarting in full-write still preserves LT-154's production/
unknown-environment mutation hold; it is not a vendor CAS workaround.

Required for authenticated Bridge HTTP review:

- `REMEDY_BRIDGE_SERVICE_KEY_FILE`: existing 64-lowercase-hex service-key file
  format, optionally one terminal LF. Every request except sanitized GET
  `/healthz` needs exactly one `X-Remedy-Service-Key`. Keys stay behind Conductor/
  Server; no browser keys, direct public panel, proxy/tunnel or new exposure.
- `CXONE_INTEGRATION_ENABLED=true` and valid `SERVER_DOMAIN`, `SERVER_KEY`,
  `SERVER_SECRET`, `SERVER_USER` for existing authorized CXone reads. Domain,
  owner sandbox configuration, network/resource and loopback restrictions are
  unchanged. This profile does **not** provide vendor credentials for reads.
- `REMEDY_REVIEWER_REQUIRED` may be omitted or true; false is rejected in this
  profile. No reviewer keyring, signing credentials, writable claim ledger or
  active signing key is required to scan/preview. Supplied signing-key settings
  do not enable a writer in this profile.

Deterministic source scan/preview are the required features. LLM providers and
rendered-browser scans remain optional, request-specific features using existing
configuration and failure reporting; readiness is not a claim those optional
external providers are reachable. Existing owned-work deadlines/admission,
preview cache limits and engine-error semantics remain in force.

Optional historical lookup additionally requires all of
`REMEDY_CLAIM_DB` (basename `claims.sqlite3`), `REMEDY_CLAIM_FENCE_DIR`,
`REMEDY_REVIEWER_TRUST_EPOCH`, and `REMEDY_OPERATION_STATUS_ISSUER`. The issuer
must be the exact existing issuer (nonempty, at most 512 characters). A missing,
partial or unhealthy optional store leaves status unavailable without preventing
healthy scan/preview. The query-only helper never initializes or repairs a store,
takes writer ownership, performs crash recovery, records revocations, appends
claims/audit, resolves quarantine or changes historical pending outcomes. SQLite
may perform transient shared-memory reader coordination; persisted logical
claim/recovery state and fence sequence remain unchanged.

## Authenticated readiness and capability consumption

GET `/readyz` retains `ok`, `state`, `capabilities`, and unavailable `error`.
All existing capability names remain strict booleans. Additive `profile` metadata:

```json
{"ok":true,"state":"ready",
 "capabilities":{"scan":true,"preview":true,"mutate":false,"operation_status":false},
 "profile":{"contract":"cxone-review-v1","name":"review-only",
 "required_capabilities":["scan","preview"],"unavailable_reasons":[]}}
```

HTTP 200 / ok:true requires scan+preview only; HTTP 503 / ok:false / state:degraded
retains `error:capabilities_unavailable`. Missing read configuration makes both
false and reports `profile.unavailable_reasons:["cxone_configuration_invalid"]`.
An actual required scan/preview dependency/engine failure makes its capability
false until successful real work retries that capability; readiness performs no
vendor probes and never claims credentials have been remotely verified. A
healthy retry restores that capability. Invalid 4xx requests and admission/
cancellation failures do not claim engine health. Stopped/full owned work is
unavailable (`owned_work_unavailable`); observed dependency failure uses
`read_dependency_unavailable`. Exhausted preview entries/bytes make preview false
(`preview_capacity_unavailable`); only expired entries are pruned, never a
still-valid reviewed token. The remaining fallback reason is
`capabilities_unavailable`. Reasons are sanitized codes, never credential values.

`mutate` is **always false** in review-only. `operation_status` is true only
when the configured query-only store passes a live consistent read. It is
optional for profile readiness. A helper/store failure makes it false; a drained
restart after safe local repair is needed if the helper failed closed. HTTP
POST `/v1/cxone/page/operation-status` retains the exact existing `{issuer,jti}`
query and metadata-only response. Auth stays mandatory. Absent optional status
returns 503 `operation_status_unavailable`; a configured failed store returns 503
`claim_store_unavailable`; a valid unknown operation returns 404. Neither failure
nor 404 authorizes retrying a past mutation. Conductor still checks current
permission and its stored operation mapping before forwarding a lookup.

Full-write remains the default and retains its all-four capability readiness
requirements, signed authentication/storage configuration and production hold.
An absent profile field in an older producer must not be inferred as review-only;
consumers must not infer mutation support from ok:true or liveness. LT-175/176
must explicitly select this version and inspect named capabilities. Global
release readiness also depends on the remaining LT-111 integration/runtime gates.

## Unavailable mutations and preserved review evidence

All HTTP apply/restore aliases (`/v1/cxone/page/apply-fix`,
`/v1/cxone/page/restore`, `/api/apply`) authenticate first, then return 503 before
body processing, work admission, preview consumption, claim/snapshot/audit or
external calls, including a cryptographically valid signed request:

```json
{"error":"review_only_profile","outcome":"not_attempted",
 "evidence_effect":"preserve","retryable":false,"operation_id":null}
```

Core HTML/tag writers, fix/pipeline apply, HTML/tag restore and manifest mutation
entry points reject early too, including no-op content. Actual CLI mutation
commands reject before reads, generated files, confirmation or snapshots.
No developer switch or signing credential enables them in review-only. The
existing signed writer, durable history and LT-154 vendor gate are retained for
the separately approved future automatic-write capability.

## Existing manual review/export support

Source scan returns findings and WCAG review evidence. Preview returns candidate
before/after HTML, a diff, opaque preview identity and the existing full-digest
`review_binding`/expiry shape; that identity grants no permission to write.
Existing HTTP JSON can be saved by an authorized caller. There is no new HTTP
report download endpoint, panel export button or book-editor integration.

Existing CLI `scan --json`, `scan --out <file>` and `scan --html <file>` report
findings/source; `fix` without --apply writes `.diff`, `.fixed.html`,
`.findings.json`; `pipeline` without --apply writes `.pipeline.diff`,
`.pipeline.fixed.html`, `.pipeline.json`. These are candidate/local artifacts,
not content already changed on CXone. Review/copy appropriate edits through the
normal book editor using its own permissions, then run a **fresh scan**. A scan,
preview, reduced finding count or generated diff never means content was fixed,
WCAG conformant, or human-reviewed. No new editor/export product is implemented.

## Verification limits

Tests execute the actual HTTP Bridge, owned workers, SDK, scan/fix, core/CLI and
SQLite reader with synthetic service keys and external CXone adapters only.
They cover useful scan/preview, missing read config, dependency failure/recovery,
valid signed mutation rejection, preview preservation, process policy capture,
zero external mutation attempts and unchanged historical pending DB/fence state.
The existing Linux image workflow runs these with external networking disabled.
Exact CI results/artifact references belong in the PR/handoff. No live vendor
call, real credentials, signing/CAS bypass or deployment is part of this scope.
