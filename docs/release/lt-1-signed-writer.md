# LT-1 signed writer integration

The approved wire contract is [r2 plus the Chief addendum](../proposals/lt-1-reviewer-wire-v1.md). Frozen corpus: `lt1-wire-v1-r2`, JSON SHA256 `fbdb4e1cb6a66ed47f2de5393a23e84a37b509ef2bf23aa001a36452c5a50e4b`.

## Native verifier and hop authentication slice

`REMEDY_REVIEWER_REQUIRED=true` loads `REMEDY_REVIEWER_KEYRING_FILE` and `REMEDY_BRIDGE_SERVICE_KEY_FILE` at startup. Invalid configuration aborts startup. Production (`NODE_ENV=production`) requires true; invalid mode values never silently select local mode. The trust epoch in `REMEDY_REVIEWER_TRUST_EPOCH` must match the keyring. No real key is supplied by this repo.

The keyring is JSON `{issuer,audience,environment,trust_epoch,keys:[...]}`. Each key has exactly its pinned policy: `kid,issuer,audience,environment,trust_epoch,kty,crv,x,not_before,not_after,enabled,revoked_at`. Public JWK `x` is canonical base64url; private key fields are forbidden. Production rejects the public fixture key and ID. Use a new ID after revocation. Native Node crypto verifies received segments with the exact `Ed25519` header; no algorithm alias or remote discovery.

Service key file format is 64 lowercase hex characters, optionally one LF. Requests use exactly one `X-Remedy-Service-Key` header. Required mode authenticates every path except GET liveness, including unknown paths and preflight. Static panel is unavailable. Strict JSON rejects duplicate decoded names, malformed UTF-8, lone surrogates and excess depth before handlers run. Browser clients must use Conductor; they must never receive service keys.

During this first slice all required-mode HTTP mutation aliases return 503 `signed_writer_unavailable`. `/readyz` reports `mutate:false,operation_status:false`; it cannot claim production readiness. Existing explicit local mode remains scoped by loopback and the owner sandbox. `/healthz` is liveness only in every mode. The deployment must use authenticated capability readiness, never infer write readiness from liveness.

This slice does not certify durable dispatch, signed HTTP writes, the upstream signer/forwarder, production topology or a full-stack release. Those stay tracked by LT-1/LT-113/LT-111. LT-122/123/124, dependency advisories and request/resource lifetime gates remain open. No live services, real credentials, public bridge/tunnel, or direct public panel are part of this work.

## Durable signed HTTP writer slice

The second slice replaces the intermediate required-mode 503 with the approved signed writer. Required startup additionally opens `REMEDY_CLAIM_DB` (basename must be `claims.sqlite3`) and `REMEDY_CLAIM_FENCE_DIR/fence.json`, using `REMEDY_REVIEWER_TRUST_EPOCH`. The database directory and fence parent must already exist. Startup never initializes or repairs missing/partial storage. A second writer fails before listening. The fence must be outside the ledger directory; production must mount it persistently and exclude it from database backups.

Runtime dependency: local POSIX Python 3 with `sqlite3` and `fcntl`, alongside Node22. The Node process retains the stable owner-lock descriptor shared with its helper, so helper failure cannot release ownership during an in-flight HTTP mutation. SQLite uses WAL/FULL, transactional nonce/token/active-target uniqueness, and retained tombstones. Every transaction commits before the independent fsynced/renamed/directory-fsynced fence; divergence stops admission. Snapshots, metadata and containing directories flush before the durable dispatch marker. A single CXone request follows; SDK 1.7.0's pinned compatibility patch also rejects redirects and applies a 30-second mutation deadline. No mutation retry is implemented.

Preview, revise-preview and restore-preview return `review_binding` and integer `review_expires_at`. Signed apply/restore consume their token before awaited eligibility checks, claim nonce/token/target durably, recheck canonical target/source/output/key/expiry, and submit exact reviewed bytes. Verified `{issuer,subject}` is recorded separately from operator; arbitrary `requested_by` cannot supply attribution. The local panel mutation alias remains 403 in required mode.

Mutation/status metadata follows r2: `pending` holds evidence; matched `no_change` preserves it; `stale_preview`/`target_mismatch`, known success and unknown writes invalidate it. Known success survives audit-append failure. Unknown dispatch is 502 with reconciliation required; its target remains quarantined after restart/new previews. Incomplete success persistence stops global write admission rather than acknowledging unrecorded success. A restored stale ledger fails against its independent fence. Neither an HTTP failure, pending status nor 404 authorizes a retry.

Read-only `POST /v1/cxone/page/operation-status` accepts exactly `{issuer,jti}` with the configured issuer and canonical nonce. It returns metadata only: no HTML, assertion, reviewer details, paths or secrets. It works before the caller has an operation ID and never dispatches CXone requests. A healthy local store plus valid CXone configuration makes authenticated readiness advertise mutation/status capability; invalid key reload disables mutation while status remains available.

Public keys load once. After an explicit local keyring replacement, send the Bridge process `SIGHUP`; this pauses admission, validates the complete file, persists effective revocations, rehydrates all historical revocations and installs the new verifier before resuming. Failure leaves writes disabled. Editing a file alone is not acknowledged revocation. Service key changes require a drained restart. Rotated/retired IDs remain consumed; clock movement and a later reload cannot re-enable a revoked ID. No private signing key belongs on Bridge.

### Local provisioning, backup and rollback

For a **new empty synthetic/local store only**, the explicit helper initializer is:

```sh
python3 packages/conductor-panel/server/ledger-helper.py \
  --directory /absolute/ledger-directory \
  --fence /absolute/independent-fence-directory/fence.json \
  --epoch chosen-trust-epoch --initialize < /dev/null
```

It holds ownership until stdin closes and refuses partial or mismatched existing stores. This command does not provision a real key or authorize a production rollout. Real storage/key provisioning remains Johnny's deployment step. No filesystem helper can detect a deliberate simultaneous rollback of database, independent fence, epoch and keys; that administrative action is unsupported.

Disable write admission and drain the process **before** any storage restore or code rollback. Preserve ledger/fence/snapshots/audit and required-signature configuration. Never restore the independent current fence with a database backup, delete lock files, truncate claims, clear quarantine or restart to bypass uncertainty. A fence/epoch mismatch keeps writes disabled; creating a new trust epoch requires new keys/IDs, old-key revocation, invalidated previews and explicit reconciliation of every unresolved target. This implementation offers no administrative unlock or resolution mutation.

### Read-only reconciliation evidence

With the configured paths/epoch, this command can inspect the existing ledger even while the writer is active:

```sh
python3 packages/conductor-panel/server/ledger-helper.py \
  --directory /absolute/ledger-directory \
  --fence /absolute/independent-fence-directory/fence.json \
  --epoch current-trust-epoch --readonly-report
```

Save stdout to a protected local report. It reads SQLite in read-only/query-only mode and validates a consistent database snapshot against unchanged independent fences. The report includes operation/target/binding-digest, reviewer and recovery references for a local operator; it contains no HTML/assertions/keys. Its output must not become a public HTTP response. An operator can append separately obtained **read-only** CXone contents/revision-history observations and a recommended disposition to that report. The command performs no network calls, startup recovery, status transition, audit repair, quarantine clearing or mutation. A subsequent administrative resolution needs separately reviewed authorization; none is automated here.

### Evidence and release limits

Behavioral tests exercise actual Bridge/core/SDK/SQLite/helper paths with synthetic keys and fake external CXone only. Tests cover frozen cryptographic vectors, HTTP auth/duplicates, exact binding/expiry, no-op/stale/renamed targets, pending lookup, lost response before operation ID, audit failure, restore, revocation/reload, replay/restart/quarantine, two simultaneous processes and lock retention after helper death. Actual Node children crash before send, during send and after external response; restart conservatively quarantines each dispatch marker. Injected SQLite/fence ENOSPC and flush crashes, stale-backup/fence mismatch and read-only reconciliation are covered. NativeNode22 and24 focused suites run locally; UbuntuNode22 CI supplies independent Linux execution. Counts and review dispositions belong in the PR/handoff.

This does not certify Conductor's signer/operation mapping, Server's forwarding/authentication or final full-stack integration. External editors can still race the final read/POST without conditional-edit support. No live CXone call, upstream deployment, public panel, tunnel, production keys or full-stack readiness is claimed. LT-1/LT-113/LT-111 stay open, alongside LT-122/123/124, dependency advisories, general request/resource ownership and the pinned storage/topology/backup/upgrade/rollback release bundle. TestSprite remains unrun because its required tunnel/public target is outside this task's authorization.
