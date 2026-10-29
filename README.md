# LibreTexts Remedy Bridge

This repository connects **Conductor and Remedy Server to CXone Expert book
pages**. It contains page scanning and remediation previews, signed guarded
apply/restore, durable operation status, snapshots and recovery. These features
remain in **one maintained codebase and build**. Review-only is an optional
rollout mode of that integration; LibreTexts chooses its rollout timing.

**Implementation delivered does not mean production writes enabled.** Automatic
CXone apply and restore are currently held in production. LibreTexts' integration
and deployment team owns obtaining the vendor atomicity contract, arranging
separately authorized validation, and completing the reviewed write-enablement
and deployment gates. This is not a request for Johnny to obtain vendor action.
There is no environment flag that clears the hold, and no vendor outreach, live
trial, credential provisioning or write enablement is authorized by this README.

## Role in the integration

| Component | Responsibility |
| --- | --- |
| Conductor | Verified staff/project authorization, review, confirmation and signing in its backend. Service/signing keys never go to the browser. |
| Remedy Server | Document engine and authenticated proxy/forwarder; owns the maintained stack deployment package. |
| **This Bridge** | CXone page reads, source/optional rendered scans, candidate HTML/diffs, independent signature checks, guarded mutation and durable recovery. |
| ADAPT accessibility scanner | ADAPT question rendering/capture, separately versioned within the same integration package. |

Bridge workspaces are `@libretexts/remedy-core` (rules, fix strategies and CXone
I/O), `@libretexts/remedy-cli` (local commands), and
`@libretexts/remedy-conductor-panel` (staff UI and Node Bridge). The private
[`browser-scanner`](browser-scanner/README.md) supplies optional full reader-page
Chromium evidence; it is distinct from the ADAPT scanner.

The stack entry point is
[Remedy Server's deployment README](https://github.com/johnnyrobot/libretexts-remedy-server-dev/blob/main/deploy/stack/README.md).
It owns cross-service URLs, authentication, mounts and compatible artifact pins.
Its current release limitations still apply: Bridge's container-local loopback
cannot be reached through an ordinary service-DNS URL. Keep the loopback guard;
do not substitute a public proxy/tunnel or bind to `0.0.0.0`. Assembled topology,
immutable deployment bundle and rollout acceptance remain LT-111/175 work; this
README does not advertise provisional Server/UI configuration as released.

## Supported modes in the same build

The released Bridge contract is **`cxone-review-v1`**, implemented and reviewed in
[PR #22 / commit `28f37e2`](https://github.com/johnnyrobot/libretexts-remedy-bridge-dev/commit/28f37e2b57d3cf05308c19f5e363ff6f782cd837).
The [exact profile/readiness contract](docs/release/lt-174-review-only-profile.md)
is the consumer reference for Server and Conductor.

| Selection | Delivered behavior | Current production status |
| --- | --- | --- |
| `REMEDY_BRIDGE_PROFILE=review-only` | Authenticated scan/review/preview. Optional query-only historical status. No signing keyring or writer storage needed for page review. | Supported/tested non-writing mode. All automatic apply/restore entry points reject before side effects. |
| `REMEDY_BRIDGE_PROFILE=full-write` (also the omitted default) with `REMEDY_REVIEWER_REQUIRED=true` | Signed verification, exact reviewed-output apply/restore, durable nonce/token/target claims, status and recovery in the same artifact. | Implementation is delivered and tested against synthetic external services; **production mutation remains unavailable** pending the write gate below. The mode's name is not enablement. |
| Bridge service omitted | Engine/Scanner features that do not need CXone. | A deployment choice within the maintained integration package; no CXone credentials required. This is not another Bridge mode value or a separate build. |

Unknown profile values fail closed. Review-only remains non-writing even if
NODE_ENV or later call options change. **Do not use development/test settings to
enable production writes.** The existing local staff panel is not a public
production interface; required authentication mode does not serve it directly.

## Prerequisites and safe local quick start

Use Node **22 or newer** and npm with the committed lockfile. The verified CI
runtime is Node 22 on Linux. The full test suite, signed writer and historical
status helper also need POSIX Python 3 with `sqlite3` and `fcntl` (Linux/macOS);
plain review without historical lookup does not open that helper. Windows and
other untested deployment/runtime variants are not certified by these checks.
Optional rendered scanning uses the separately configured sandboxed Chromium
runtime and its private authentication/resource policy.

From this repository root, these commands exercise local fixtures and synthetic
services without CXone credentials:

```sh
npm ci
npm run build
npm test
CXONE_INTEGRATION_ENABLED=false node packages/cli/dist/index.js scan-file fixtures/chap01-like.html
```

A scan command may exit **1 when findings exist**; that is not a claim that the
content was fixed. Preserve `.env` if it already exists; use `.env.example` as a
configuration reference, not an overwrite command. Never commit secrets. Keep
`REMEDY_SDK_DEBUG` off: SDK diagnostic logging can expose a signed credential.
Installation must run the guarded postinstall SDK patch; do not use
`--ignore-scripts` or force dependency changes around its version checks.

For connected HTTP use, first select a mode and supply the already-authorized
configuration below through protected deployment configuration/secret mounts.
Then start the same Bridge source entry point from the repository root:

```sh
NODE_ENV=production node --import tsx packages/conductor-panel/server/server.ts
```

This command does not provision keys, initialize a store, grant page access or
clear the production hold. Missing mandatory authentication/writer configuration
fails startup. With review-only selected, missing CXone read configuration instead
reports unavailable capabilities. The bind remains `127.0.0.1:5175` by default;
`CONDUCTOR_API_HOST` accepts loopback only. Use Conductor/Server for staff access,
never expose a service key or this port to browsers/the public internet.

## Verified configuration

Names below are implemented configuration, not proposed enablement switches.
Values are supplied by the authorized deploying team; no real secret is included.

| Configuration | Review-only | Authenticated signed writer mode |
| --- | --- | --- |
| `NODE_ENV` | Use `production` for a deployed service. | Use `production`; production/unknown signed mutation is held. |
| `REMEDY_BRIDGE_PROFILE` | Exact `review-only`. | Exact `full-write`, or omitted default. |
| `REMEDY_REVIEWER_REQUIRED` | Omitted or exact `true`; `false` is rejected. | Exact `true` for the authenticated integration; production requires it. |
| `REMEDY_BRIDGE_SERVICE_KEY_FILE` | Required existing service-key file. | Required existing service-key file. |
| `CXONE_INTEGRATION_ENABLED`, `SERVER_DOMAIN`, `SERVER_KEY`, `SERVER_SECRET`, `SERVER_USER` | Enabled page features require `true` plus valid authorized read credentials. | Required for page features, independently of signed-write prerequisites. |
| `REMEDY_REVIEWER_KEYRING_FILE` | Not required for page review; cannot enable writes here. | Required pinned public reviewer keyring. No private signing key belongs on Bridge. |
| `REMEDY_REVIEWER_TRUST_EPOCH` | Needed only with optional historical status. | Required; matches keyring and existing ledger/fence. |
| `REMEDY_CLAIM_DB`, `REMEDY_CLAIM_FENCE_DIR` | Optional historical lookup; database basename must be `claims.sqlite3`. | Required pre-existing store and independent fence. Startup never initializes/repairs them. |
| `REMEDY_OPERATION_STATUS_ISSUER` | Required with the optional historical store; exact existing issuer. | Unused in signed mode; the request issuer must match the keyring. |
| `REMEDY_SNAPSHOT_DIR`, `REMEDY_AUDIT_LOG` | No mutation snapshots/audit are created by this mode. Preserve historical storage. | Protected persistent snapshot/audit storage; preserve through upgrades/rollback. |

In signed mode the keyring issuer, audience, environment and trust epoch must
match the deployment; a production keyring uses `environment: production` and
production refuses public test keys. The full schema is in the signed contract
below. In both modes, `REMEDY_CLAIM_DB` must end in `claims.sqlite3` when used;
`REMEDY_CLAIM_FENCE_DIR/fence.json` is independent of the ledger directory.

Service-key files contain 64 lowercase hex characters, optionally one terminal
LF. Server sends exactly one `X-Remedy-Service-Key`; all sensitive reads,
previews, status and mutations require it. Only sanitized `GET /healthz` liveness
is unauthenticated. That response does not establish readiness or write support.

Current CXone host configuration accepts **`dev.libretexts.org` only**. Existing
owner-write scope is **`Sandboxes/johnnyphung` and descendants**. Keep the default
`CXONE_ALLOWED_HOST`/`CXONE_ALLOWED_ROOT` and legacy `REMEDY_WRITE_ALLOWLIST` policy;
broader values are rejected. Another production host or target scope needs a
separate reviewed policy/integration change, not a configuration bypass.

Optional LLM configuration (`REMEDY_LLM_PROVIDER` and the selected provider's
credential/model settings) is documented in `.env.example`. Optional rendered
scans use `RENDER_SCANNER_URL` and `RENDER_SCANNER_TOKEN` with the private
[browser scanner policy](browser-scanner/README.md). Deterministic source review
readiness does not certify those optional providers are reachable.

## Readiness, scan and manual review

Authenticated `GET /readyz` returns strict boolean capabilities `scan`, `preview`,
`mutate`, `operation_status`, plus `profile.contract`, `profile.name`,
`profile.required_capabilities` and sanitized `profile.unavailable_reasons`.

- Review-only requires **scan and preview** for HTTP 200 / `ok:true`. `mutate` is
  always false; optional historical status may also be false. Missing required
  read configuration, observed required dependency failure or exhausted owned/
  preview capacity remains unready. Healthy required work can establish recovery.
- Signed full-write readiness requires all four capabilities. While the production
  gate is open, `mutate:false` makes it degraded even when reads/status work.
- Consumers must inspect the selected mode and named capabilities. Do not infer
  mutation support from liveness, `ok:true`, or an older producer without metadata.

Use the authenticated existing page scan and preview API through Conductor/Server:
`POST /v1/cxone/page/scan` and `POST /v1/cxone/page/preview-fix`. Preview returns
before/after candidate HTML, diff and the existing review identity/expiry shape.
It does not write a page. In review-only, apply/restore aliases return HTTP 503
`review_only_profile` before body work, token consumption, claims or external
calls. Core and CLI mutation entries are closed too.

With authorized read configuration, existing CLI `scan`, `fix` and `pipeline`
without `--apply` can save findings, diffs and candidate HTML. `scan --json` prints findings to stdout;
`scan --out <file>` saves findings and `scan --html <file>` saves source. `fix` saves `.diff`,
`.fixed.html`, `.findings.json`; `pipeline` saves `.pipeline.diff`,
`.pipeline.fixed.html`, `.pipeline.json`. There is no new report-download API,
export button or book-editor product. Use the normal authorized editor for manual
changes and run a **fresh scan** afterwards. Scanning, a candidate fix or fewer
findings never establishes fixed content, WCAG conformance or human sign-off.

## Production write gate and its owner

**LibreTexts' integration/deployment team owns this unresolved gate and rollout
decision.** It must obtain a current vendor-supported content-edit contract for
the exact deployed CXone version and an atomic precondition that distinguishes
**every intervening revision**, including same-timestamp revisions. It must define
consistent content/token reads, no-content-write conflict rejection, accepted/
rejected response classification and finality/recovery after uncertain dispatch.
Separately authorized validation must name exact targets, bounded trials,
synthetic content and safe cleanup; finite successful trials do not prove atomicity.

The supported mechanism must then be integrated and reviewed, validated through
apply **and restore**, and included in the compatible deployment/security/recovery
acceptance before an explicit write-enablement decision. A vendor answer, local
lock, timestamp/hash/reread heuristic, signing key or mode change cannot clear
this implementation hold. Production/unknown signed requests currently return
HTTP 503 `conditional_write_unproven`; no production full-write readiness is
claimed. Existing signing/apply/restore/recovery code and tests remain delivered.

Read the [conditional-edit evidence/gate](docs/release/cxone-conditional-edit-gate.md),
[vendor question packet](docs/release/lt-154-vendor-questions.md) and
[bounded authorized-validation preparation](docs/release/lt-154-canary-plan.md).
They do not authorize outreach or live execution. LibreTexts can choose an
optional review-only rollout while this automatic-write requirement stays open,
or wait; no mandatory first-rollout order is imposed.

## History, deployment, backup and rollback

Historical `POST /v1/cxone/page/operation-status` remains authenticated and
read-only. Its additive [terminal-proof contract](docs/contracts/cxone-terminal-v1.md)
projects stored, bound `known_success`/`not_attempted` evidence without rewriting
the operation. Those trusted terminal facts need no redundant offline ceremony;
Conductor still requires its separately reviewed explicit recovery, current
permissions, fresh scan and local version check. Lookup never unlocks a claim.
Pending/absent/untrusted state remains held; `unknown_write` still needs the
existing durable offline operator resolution, including when a reply was lost. Review-only can query existing pending history without opening a
writer, changing outcomes, recovering claims or clearing quarantine. A lookup
failure or 404 never authorizes retrying a past mutation. Signed mode preserves
nonce/token tombstones, snapshots, audit and independent fencing. Unknown writes
stay unknown; no automatic retry or restart can resolve uncertainty.

Use the [signed integration, storage and rollback contract](docs/release/lt-1-signed-writer.md)
and [separate audited offline resolution procedure](docs/release/lt-159-offline-resolution.md).
Drain before mode changes, upgrades or storage work. Preserve the ledger, current
independent fence, snapshots, audit and pending evidence; never reset data to
change modes or restore an old fence with a database backup. A damaged/mismatched
store remains unavailable until separately reviewed recovery. Offline resolution
does not enable production writes. The Server-owned deployment README above owns
the assembled version/configuration/backup/rollback handoff; no complete
production-compatible bundle or live rollout is certified here.

## Verification and current limitations

The released review contract was verified with real HTTP/owned workers/SDK/core/
CLI/SQLite and synthetic external services. At the PR #22 merge, fresh local tests
passed **506 core + 3 panel + 5 canary checks**, and exact-main Node 22 and
network-isolated Linux Bridge/Chromium CI passed. These checks are not live
library/vendor validation, assembled production acceptance or a TestSprite UI
verdict. See the [request/resource and dependency evidence](docs/release/lt-153-owned-work.md).

Known dependency inventory remains **2 high advisories** in the SDK's dormant
nested/embedded Axios chain. The reviewed postinstall routes actual ESM/CJS
request instances through pinned Axios 1.21.0; the dormant code is still present,
so this is not an advisory-free or vendor-patched SDK. Do not skip the patch.
Known minor follow-ups include LT-182 (invalid locator can temporarily degrade
readiness until successful work) and LT-183 (review-only tag dry-run support/
rejection clarity); HTML scan/preview is the advertised review capability.
Bridge terminal proof is delivered by LT-179; cross-stack known-success/lost-reply
recovery acceptance remains LT-180/127 work; a read-only lookup does not automatically clear local pending state.
Global LT-111/113 still tracks execution/security/data bounds, actual cross-stack
compatibility and the immutable deployment/backup/upgrade/rollback bundle.
