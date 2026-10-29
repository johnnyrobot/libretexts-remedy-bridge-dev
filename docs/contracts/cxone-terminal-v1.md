# CXone terminal operation proof, version 1 (LT-179)

Contract identifier: `cxone-terminal-v1`. Fixture version:
`cxone-terminal-v1-fixtures-r1` in [the synthetic fixtures](cxone-terminal-v1-fixtures.json).
This is an additive projection of the existing persisted ledger, not a new
signing protocol, write authorization, vendor guarantee or reconciliation API.

## Transport and availability

Use existing authenticated `POST /v1/cxone/page/operation-status` with exactly
`{"issuer":"<stored issuer>","jti":"<stored nonce>"}`. No target, operation ID,
assertion or proof supplied by the caller is accepted as a lookup substitution.
Conductor must derive this pair from its stored intent and check current user,
tenant/project and support permissions. Server uses `X-API-Key` inbound and
`X-Remedy-Service-Key` to Bridge; keep private routing and TLS for off-host hops.
Bridge's loopback guard and all current authentication remain mandatory.

No new environment variables or schema migration. Both existing full-write and
optional review-only historical lookup return this contract. Review-only needs
its existing service/issuer/epoch/database/fence configuration, not a signer or
writer. Startup of a writer can perform its existing crash recovery; **lookup
itself never does**. A query-only profile leaves pending rows pending.

All old status fields and meanings remain. A successful lookup adds exactly:

| Field | Meaning |
| --- | --- |
| `terminal_proof` | Object below only for stored terminal `known_success` or `not_attempted`; otherwise JSON null. |

An absent operation is HTTP 404 `operation_not_found`, not proof of no write.
Bad query/unauthorized issuer is 400; missing service authentication is 401.
An unreadable, malformed or inconsistent store/fence is 503
`claim_store_unavailable`, with no proof and no invented mutation outcome.
Unconfigured historical status retains its existing unavailable behavior.

## Exact proof object

| Field | Type and source |
| --- | --- |
| `contract` | Exact string `cxone-terminal-v1`. |
| `issuer`, `jti` | Exact original stored claim strings, never echoed from the request. |
| `operation_id` | Original ledger operation UUID. |
| `action` | Original `cxone.apply` or `cxone.restore`. |
| `target` | Stored canonical identity `{hostname, page_id}`; page ID is a decimal string. Full reviewed page path is included in the binding hash. |
| `binding_sha256` | Original stored lowercase SHA-256 of the **entire** signed review binding, including target path, preview token, before/after hashes, fix mode, tier and snapshot. |
| `outcome` | Original `known_success` or `not_attempted`. |
| `reason` | Known success: null. Not attempted: `no_change`, `stale_preview`, `target_mismatch` or `pre_dispatch_failure`. |
| `audit_recorded` | Original known-success boolean, including false; not attempted: null. A fresh scan cannot manufacture missing historical audit. |
| `state` | Exact `terminal`. No active target claim may remain for these outcomes. |
| `terminal_updated_at` | Original terminal row timestamp, unchanged by lookup. It is identity/version context, never a time-based settlement heuristic. |
| `trust_epoch` | Current configured epoch, matching both ledger metadata and independent fence. |
| `durability_seq` | Nonnegative JavaScript-safe integer (at most 9007199254740991) from a single consistent ledger/fence observation. This is a store-wide sequence, **not an operation version**. Unrelated durable events may advance it. |

The terminal row/identity/outcome are immutable under the existing writer state
machine. Epoch/sequence are trustworthy only within the protected storage,
independent fence and authenticated deployment. This response is **not separately
signed**, portable bearer proof or permission to write. Restoring a database and
its old fence together remains forbidden; this addition cannot detect an
unauthorized rollback of the entire trust boundary.

The binding digest preserves the deployed ledger's existing algorithm:
Python `json.dumps(binding, sort_keys=True, separators=(',', ':'),
ensure_ascii=True)`, encoded as UTF-8, then SHA-256. This is **not RFC 8785/JCS**.
The reviewed binding schema has ASCII member names, only integer/null tier and
strings/objects/null. Sort object names recursively; no insignificant whitespace;
escape all non-ASCII code units, including surrogate pairs, as lowercase `\uXXXX`.
The fixture contains literal canonical bytes and independently calculated digest,
including a non-ASCII page path. Hash the original stored signed binding, not a
new preview, source HTML, subset or fields supplied by a recovery request.

## Read consistency and zero mutation

The helper opens SQLite `mode=ro`, enables `query_only`, begins a read transaction,
reads the selected claim and existing resolution, and compares the transaction's
metadata against independent fence reads before and after. Any disagreement
fails closed. Writer-profile lookups use this same read-only snapshot path.
There are zero ledger, event, resolution or fence writes, no ownership takeover,
claim release, revocation, remote read/write, preview consumption or recovery.
SQLite may coordinate transient shared memory; this is not a promise of zero
filesystem activity. The report/offline-resolution formats are unchanged.

Pending and unknown operations always have `terminal_proof:null`. Even an
operator-resolved unknown retains its original `unknown_write` outcome and null
terminal proof: use the existing durable offline-resolution contract for that
separate recovery path. Do not reinterpret it as known success or no-op.

## Consumer and operator workflow

1. Retrieve the current status using the stored pair and authenticated hops.
   Check the known contract and exact original intent: issuer, nonce, operation,
   action, canonical identity, full binding digest and configured trust epoch.
   Confirm outer status and proof outcome/reason/audit/time agree.
2. A trusted terminal known-success/not-attempted record needs no redundant
   offline mutation solely to restate the terminal fact. It still requires the
   separately reviewed explicit Conductor recovery action, current permissions,
   a fresh canonical scan, immutable preparation and local expected-version CAS/
   commit marker. Lookup alone never clears a local pending claim or conformance.
3. Re-fetch authoritative proof after the scan and before local commit. Require
   the same bound terminal/trust context; conservative consumers can require
   byte-for-byte proof equality including the observed sequence. A changed
   observation requires revalidation/preparation, never a mutation retry.
   Missing/malformed proof, mismatch, pending, absent/404, untrusted or changing
   state remains held. No source-equality or elapsed-time shortcut is permitted.
4. For `unknown_write`, retain the existing [drained offline operator procedure](../release/lt-159-offline-resolution.md)
   and its preserved resolution evidence. Neither this lookup nor a fresh scan
   settles an uncertain remote operation. Original actor/outcome/nonce/history,
   snapshots and audit remain preserved.

`not_attempted/no_change` preserves evidence only under its existing semantics;
`stale_preview` and `target_mismatch` invalidate old evidence. Actual mutation
and unknown write invalidate evidence. A terminal receipt does not establish
WCAG conformance or vendor atomicity, enable production apply/restore, or bypass
[the LibreTexts-owned production write gate](../release/cxone-conditional-edit-gate.md).

Conductor consumption is separately tracked by LT-180. This producer contract is
not a claim that Conductor's recovery action or the assembled production package
has passed its own acceptance gates.
