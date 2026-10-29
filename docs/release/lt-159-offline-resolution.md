# Offline resolution of an unknown operation (LT-159)

This is a separate local administrative action for Johnny or an explicitly
approved operator. It makes no remote requests. `reconcile` and operation-status
remain read-only. An unknown write remains unknown forever: resolution records
that an operator reviewed evidence and established external settlement. It does
not assert success, failure, atomic vendor writes, or production readiness.

## Before recording a resolution

Disable admission and stop/drain every writer using this store. An exclusive
POSIX owner lock enforces process exclusion, including a Node owner whose helper
has failed; never unlink/replace `owner.lock`. Exclusive ownership cannot prove a
remote vendor request has settled. Establish settlement independently using
vendor-supported finalization evidence and revision history. Elapsed time, an
HTTP 4xx, matching source, or credential rotation does not establish settlement.
If settlement cannot be established, leave the target quarantined.

Preserve the pre-resolution report, snapshots, audits and vendor evidence in
restricted local storage. Make a cold backup of the ledger directory after drain
(including any WAL/SHM), plus a separately identified copy of the independent
fence for evidence. Never restore the fence alongside an old database to force
trust. The current independently retained fence must survive rollback. Protect
store/fence ancestors and operator evidence against concurrent local writers.

Generate a fresh read-only report after drain with the existing command:

```sh
python3 packages/conductor-panel/server/ledger-helper.py \
  --directory /approved/ledger --fence /independent/fence.json \
  --epoch APPROVED_EPOCH --readonly-report > /restricted/report.json
```

Hash the exact report bytes using `shasum -a 256 /restricted/report.json`.
Prepare a separate restricted decision JSON; placeholders must be replaced with
the exact report values, never guessed:

```json
{
  "operation_id": "EXACT_OPERATION_UUID",
  "target": {"hostname": "EXACT_HOST", "page_id": "EXACT_ID_STRING"},
  "trust_epoch": "APPROVED_EPOCH",
  "expected_seq": 42,
  "expected_state": "terminal",
  "expected_outcome": "unknown_write",
  "expected_updated_at": "EXACT_ORIGINAL_UPDATED_AT",
  "report_sha256": "SHA256_OF_EXACT_PRESERVED_REPORT_BYTES",
  "operator": "APPROVED_OPERATOR_IDENTITY",
  "reason": "Evidence references and reviewed settlement decision",
  "external_settlement_acknowledged": true,
  "writer_drained": true
}
```

The two acknowledgements are explicit operator attestations. This command cannot
independently certify their truth. No credentials belong in the report/decision.
The preserved report and decision are copied into an append-only resolution
record with a tool-generated UTC timestamp. Decision and report files are each capped at 16 MiB. A store whose full report
exceeds that limit remains quarantined until reviewed tooling supports it; do not
filter the report or delete history to fit. The entire report must still match
current store state and sequence; another operation or revocation makes it stale.

```sh
python3 packages/conductor-panel/server/ledger-helper.py \
  --directory /approved/ledger --fence /independent/fence.json \
  --epoch APPROVED_EPOCH --offline-resolve /restricted/decision.json \
  --report-file /restricted/report.json
```

## Durable result and recovery

Only an active terminal unknown operation can resolve. Any pending operation,
wrong target/state/epoch/version/hash, other owner, replay or missing evidence
refuses. SQLite FULL commit appends the event and releases exactly that target;
the independent sequence fence is fsynced before success is returned. A crash
between the two commits leaves mismatched trust and fails the entire store closed.
A crash after both durable commits may lose the receipt: inspect the read-only
report before any further action. Never blindly repeat the command.

Original outcome, reason, timestamps, snapshots, audits, issuer/nonce and preview
tombstones remain. Existing operation-status fields become
`reconciliation: "resolved"`, `requires_reconciliation: false`, with `updated_at`
from the durable event. `outcome: "unknown_write"`, null applied/restored result
and `evidence_effect: "invalidate"` remain. Resolved never means successful.

On any storage/fence error, preserve all artifacts and stop. Do not manually
edit SQLite, lower a sequence, recreate the epoch, or delete claims. A trusted
recovery decision is required to restore a compatible current store. Rolling
back application code cannot undo an administrative record or remote write;
retain compatible readers, cold backups and the current fence.

Restart only after the operator independently authorizes it. Conductor LT-127
must explicitly consume durable resolved status through an authorized resolve
flow and then rescan/CAS its local record. A read-only lookup alone never clears
local pending state. No new assertion or body fields are introduced. Resolution
cannot enable writes: the production `conditional_write_unproven` hold remains.

## Agent verification scope

Only synthetic stores/processes and network-denying tests are used. Tests cover
actual competing owners, stale evidence, target-specific release, consumed
nonce/token replay, original unknown preservation and crash/ENOSPC boundaries.
No live resolution, credential use, vendor request or deployment is authorized.
