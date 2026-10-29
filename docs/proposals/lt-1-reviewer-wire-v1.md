# LT-1 proposed reviewer assertion wire contract, version 1

**Status: proposed, awaiting Accessibility Chief approval.** Prepared 2026-10-28 for LT-1 / LT-113 / LT-111. This document specifies the next cross-repository slice; it implements no signer, forwarder, verifier, exposure change, or production credential. ADR-0001 and the enforced loopback-only listener remain in force. Real signing credentials and a coordinated live rollout remain Johnny-only.

## Decision requested

Approve this exact v1 contract (Ed25519 JWS; `reviewer_assertion` JSON transport; Bridge-produced `review_binding`; a durable single-writer claim ledger) before Conductor, Remedy Server, and Bridge implement their respective portions. Chief must separately approve the deployment topology, storage/backup policy, and any future exposure policy. This proposal does not widen the current owner sandbox allowlist.

## Ownership and trust

Conductor verifies its user JWT and current project mutation permission, resolves the project's **stored** canonical CXone target, and obtains a preview from the configured Remedy service. It stores the preview token, binding, and reviewed diff against that user/project/session; browser-supplied target, binding, subject, or assertion never override those records. At explicit confirmation it rechecks permission, project target, current review identity, and expiry, then signs exactly that stored preview binding. A changed target, tier, mode, output, or snapshot invalidates review and requires a new preview and confirmation. An auditor/foreign-project user cannot obtain a mutation assertion. `sub` is the immutable verified Conductor user ID, not an email/display name or a request field.

Remedy Server authenticates its Conductor caller using its ordinary service policy, forwards the compact assertion string **unchanged**, and never mints assertions or substitutes `requested_by`. Bridge verifies independently before mutation and derives `requestedBy` from verified `iss` + `sub`. Service authentication and signed attribution are separate requirements. Calls involving an assertion must use authenticated configured service channels; a signature does not make a public panel, arbitrary proxy, or tunnel approved.

## Transport and routing

`POST /v1/cxone/page/apply-fix` and `POST /v1/cxone/page/restore` receive one `reviewer_assertion` string in their JSON body, alongside `preview_token` and the existing compatibility `preview_hash`. No Authorization-header overload, URL parameter, cookie, multiple assertion fields, or camelCase alias. Assertion bytes must be printable ASCII, at most 8192 bytes, with exactly three nonempty unpadded base64url segments. Reject whitespace, padding, noncanonical base64url encodings, detached payloads, and additional segments. Do not log the assertion or include it in audit/snapshot metadata.

Preview and revise-preview responses add `review_binding` to their existing fields. Restore-preview adds canonical page identity and `review_binding`. This is additive on reads. Once the signed path is enabled by an approved rollout, missing assertions fail closed on **every HTTP mutation alias**, including `/api/apply`; tokenless mutation is rejected, never regenerated. The local panel must use an approved signer flow or be mutation-disabled in required-signature mode. CLI/operator workflows remain separately scoped local operations and must not provide an HTTP bypass. No automatic downgrade from required-signature mode.

## Signature and key selection

Use compact JWS, protected header exactly `{ "alg": "Ed25519", "kid": "<configured-id>", "typ": "remedy-review+jwt" }`. No additional header members, embedded `jwk`, `jku`, certificate URL, `crit`, `b64`, or unsigned header. Only raw Ed25519 signing/verification of the JWS signing input is permitted; reject `none`, HMAC, RSA, `EdDSA`, Ed448, and cross-algorithm key use. RFC 9864 defines the fully specified `Ed25519` JOSE identifier; this is a deliberate new contract, not silent acceptance of both algorithm names. All three implementations must demonstrate their chosen crypto library supports that exact identifier before landing.

`kid` matches `[A-Za-z0-9._-]{1,64}` and selects an exact entry in a locally provisioned keyring. Each entry pins issuer, audience, environment, `kty=OKP`, `crv=Ed25519`, public key, validity window, and enabled state. It is never a filename, network URL, or discovery input. Unknown/disabled IDs fail closed without fetching anything. Production must refuse the fixture ID and public fixture key used below.

Signing input is ASCII `base64url(UTF8(headerJSON)) + '.' + base64url(UTF8(payloadJSON))`; signature is 64 raw bytes, then unpadded base64url. Verify the **received encoded segments**, never parse then reserialize before verification. JSON object member order and JSON whitespace are not cryptographic canonicalization requirements: two valid JSON encodings are different signed byte strings and independently verifiable. After signature verification, parse strict UTF-8 JSON and reject duplicate names at every depth, invalid Unicode/surrogates, arrays where objects are required, unknown/missing members, or wrong types. The fixture freezes exact JSON texts and bytes for cross-language verification. No JCS dependency or undocumented JSON key sorting is required.

## Exact payload

All fields below are required; no extra fields. `review_binding` itself is the object in the `binding` claim.

| Field | Type and rule |
|---|---|
| `v` | Integer `1`. |
| `iss` | Exact configured environment-specific issuer, e.g. `urn:libretexts:conductor:test`. |
| `aud` | One exact string for the receiving Bridge deployment, e.g. `urn:libretexts:remedy-bridge:test`; arrays forbidden. |
| `sub` | Verified immutable Conductor user ID, 1–128 printable ASCII characters, no controls. Audit records `{issuer, subject}` without conflating it with operator. |
| `iat`, `nbf`, `exp` | Safe integer Unix seconds. `nbf == iat`, `0 < exp-iat <= 60`. At verification time `iat <= now+5`, `nbf <= now+5`, and `now < exp` (no expiry grace). `exp` cannot exceed Bridge preview expiry. |
| `jti` | Nonce: unpadded base64url of 32 cryptographically random bytes (43 chars). Unique for the issuer across all actions/targets. |
| `binding` | Exact object described below; equality is structural with exact primitive types/values, never coercion or normalized comparison. |

`binding` contains exactly these members:

| Field | Type and rule |
|---|---|
| `action` | `cxone.apply` or `cxone.restore`; fixed by route, never by caller mode alone. |
| `target` | Exactly `{hostname, page_id, page_path}`. Host is lowercase configured DNS host without trailing dot, port, scheme, or credentials. `page_id` is canonical positive decimal **string**, no leading zeros, within JS safe integer range. `page_path` is Bridge's canonical authoritatively resolved path. |
| `preview_token` | Exact opaque token Bridge issued; UUID-form currently, do not derive from content. Token must refer to an unexpired stored preview. |
| `before_sha256` | 64 lowercase hex SHA-256 of UTF-8 source HTML bytes used by the preview; no HTML normalization, truncation, or newline rewriting. |
| `after_sha256` | 64 lowercase hex SHA-256 of exact UTF-8 HTML bytes Bridge will submit to CXone; includes any byte-preserving patch result, computed **before review**. No later regeneration or unreviewed serialization. |
| `fix_mode` | `deterministic`, `pipeline`, or `restore`. Apply accepts first two; restore accepts only `restore`. |
| `tier` | Integer 1–3 for pipeline; `null` for deterministic/restore. |
| `snapshot` | `null` for apply; for restore exactly `{timestamp, sha256}`, where timestamp is exact selected metadata ISO string and hash is full SHA-256 of restored HTML bytes. |

The Bridge creates the target from authoritative `resolvePageRef` metadata, using the exact returned path in the stored binding. The writer separately checks the owner sandbox policy (currently `normalizeSandboxPath` rejects traversal, backslash and NUL forms); that predicate does not rewrite the path in this binding. Canonical preview output is authoritative: Conductor and Server **copy it unchanged**, never independently decode/re-encode its path. Before write, Bridge resolves input and numeric ID, checks their agreement and allowlist, compares the canonical target to the stored preview and signed claim, and submits only to that numeric ID. A page rename/move requires a fresh preview. Signing does not override owner allowlist, feature flag, stale-source check, or content policy.

The current `preview_hash` is a 16-hex compatibility hash (`guardrails.ts:hashContent`); it remains a UI compatibility field, **not** either full digest above. This proposal requires additive full digest fields rather than pretending that existing field is a SHA-256 commitment. Preview output must already be final wire HTML; if the writer changes bytes after review, the binding must fail before mutation.

## Verification, claim, and outcomes

1. Enforce body/encoding limits, fixed header/schema, configured key policy, signature, issuer/audience, time, and exact binding equality to the stored preview. Validate route/action and current canonical target/authorization. No mutation or successful attribution occurs before all checks pass. Signed identity is never taken from `requested_by`; conflicting legacy attribution is rejected in required-signature mode.
2. Synchronously claim the preview in process before any awaited work can interleave. Persist a unique `(iss,jti)` claim and token claim atomically before starting a remote mutation. The approved production implementation needs a transaction with uniqueness constraints and durability; an in-memory Map is insufficient across process restart. A failed durable claim produces no remote write. Ledger availability failure fails closed.
3. Serialize all mutation kinds for the canonical `(hostname,page_id)`, not only identical tokens. In the lock, re-resolve target and re-read source; stale content rejects without writing. This is local serialization only: do not claim protection from outside editors without independently verified CXone conditional-edit support.
4. Persist a `write_started` record before sending. Make one mutation attempt; disable transport/HTTP/proxy mutation retries. Success received from CXone is `known_success`, even if later audit append fails; return `audit_recorded:false` with a durable recovery reference. A transport failure after submission may be `unknown_write`; consume preview/nonce, durably quarantine the target, invalidate prior evidence, and forbid further mutation until explicit reconciliation. No inferred rollback or blind retry.
5. A lost Bridge response also requires a read-only outcome lookup keyed by the claim, not resubmission. Retain claim/outcome records until at least `exp+5` and until any unknown outcome is reconciled; outcome/audit retention beyond that is an explicit deployment policy. An unfinished `write_started` found after crash becomes `unknown_write`, never available again. New preview creation does not clear quarantine. A duplicate request returns conflict plus a recovery reference, never performs another write.

First implementation supports one Bridge writer instance with durable storage, retaining its startup loopback guard. Multi-replica writes need a shared transactional ledger and distributed per-page exclusion; do not advertise them from process-local locks. Preview state may expire on restart, but durable consumed/unknown claims must survive. Claim-ledger storage and snapshots must be included in reviewed backup/recovery/rollback policy; restoring old consumed-nonce state can re-enable old writes and is not a safe rollback.

## Rejections and response contract

Errors are JSON `{error, outcome:'not_attempted', retryable:false}` unless a remote attempt occurred; do not echo assertions or cryptographic internals. HTTP 401 `reviewer_assertion_required` for missing assertion; 401 `invalid_reviewer_assertion` for malformed/bad signature/key/issuer/audience/time; 403 `reviewer_binding_mismatch` for valid signature but wrong route/action/target/preview/output; 409 `expired_preview`, `stale_preview`, or `preview_already_claimed`; 503 `claim_store_unavailable` before write. Known success uses 200 `{applied|restored, outcome:'known_success', audit_recorded, operation_id}`. Unknown remote outcome uses 502 `{error:'write_outcome_unknown', outcome:'unknown_write', retryable:false, operation_id, requires_reconciliation:true}`. Callers invalidate old conformance evidence for both known success and unknown write; only a new actual scan can establish fresh evidence. All response mappings remain proposed until approved by Chief and implemented coherently.

Required negative tests: missing/forged signature; alg/key-type confusion; unknown/disabled kid; embedded key/URL; duplicate JSON names; padded/noncanonical encoding; wrong issuer/audience; array audience; noninteger/overflow time; future, expired and >60s lifetime; unknown fields; action swap; target host/ID/path mismatch; renamed page; same source with different output; revised preview/new token; changed tier; restore snapshot changed; legacy requested_by conflict; concurrent identical nonce/tokens; distinct nonce/tokens on same page; replay after restart; claim-store outage; response loss; post-write audit failure; replay after crash/backup restore; read-only Conductor user; forwarder tampering; fake test key refused outside test. Successful forwarding test must execute owned Conductor -> Server -> Bridge with fake external CXone and confirm exact compact bytes, verified reviewer and separate process operator in evidence.

## Provisioning and rotation handoff

Proposed names (names only): Conductor `REMEDY_REVIEWER_SIGNING_KEY_FILE`, `REMEDY_REVIEWER_KEY_ID`, `REMEDY_REVIEWER_ISSUER`, `REMEDY_REVIEWER_AUDIENCE`; Bridge `REMEDY_REVIEWER_KEYRING_FILE`, `REMEDY_REVIEWER_REQUIRED`, `REMEDY_CLAIM_DB`. Server receives no reviewer signing key. No secret in image, source, browser, logs, or fixture. File permissions, container UID, mounts and health/preflight are a separate reviewed deployment deliverable.

Rotation order: provision new public key alongside old at Bridge, validate readiness, switch Conductor signing to new ID, wait at least maximum assertion lifetime + skew + in-flight bound, then retire old key. Emergency disable rejects old ID immediately. Required-signature startup fails when keyring/ledger/issuer/audience is absent, invalid or unwritable. Rollback never silently disables signature enforcement or restores an older consumed-claim ledger. Johnny performs real key provisioning and live coordination only after the code, full-stack synthetic test, deployment bundle, and exposure policy are approved.

## Fixture and evidence

`lt-1-reviewer-wire-v1-vectors.json` contains exact protected header and payload JSON strings, signing input, signature and compact assertion for synthetic apply and restore. `lt-1-reviewer-wire-v1-vectors.mjs` regenerates and verifies them using Node crypto, with a deterministic seed derived from a **public test phrase**. This is intentionally forgeable test material, never a credential. The script checks signature bytes and selected negative cryptographic cases; it does **not** implement or prove the proposed product verifier, claim ledger, HTTP transport, time validation, or cross-stack behavior. Fixed `now=1793255370` is a test clock, not current-time validity.

Primary sources inspected in the Browser tab on 2026-10-28: [RFC 9864 §2.2 / §4.1.1](https://www.rfc-editor.org/rfc/rfc9864.html#section-2.2) specifies the fully identified algorithm; [RFC 8037 §2 and §3.1](https://www.rfc-editor.org/rfc/rfc8037.html#section-2) defines OKP key representation and Ed25519 signature inputs; [RFC 7515 §3.1 and §5.2](https://www.rfc-editor.org/rfc/rfc7515.html#section-3.1) defines compact serialization and verification. Claim shape, transport name, 60-second lifetime, replay/storage policy, and error taxonomy above are **our proposed application decisions**, not requirements asserted by those standards. Local sources: `packages/conductor-panel/server/server.ts` preview/apply/restore routes; `packages/core/src/client.ts` resolver; `packages/core/src/guardrails.ts` path/allowlist/hash; `packages/core/src/write-page.ts` serialization; ADR-0001.
