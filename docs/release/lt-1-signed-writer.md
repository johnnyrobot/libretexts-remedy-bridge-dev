# LT-1 signed writer integration

The approved wire contract is [r2 plus the Chief addendum](../proposals/lt-1-reviewer-wire-v1.md). Frozen corpus: `lt1-wire-v1-r2`, JSON SHA256 `fbdb4e1cb6a66ed47f2de5393a23e84a37b509ef2bf23aa001a36452c5a50e4b`.

## Native verifier and hop authentication slice

`REMEDY_REVIEWER_REQUIRED=true` loads `REMEDY_REVIEWER_KEYRING_FILE` and `REMEDY_BRIDGE_SERVICE_KEY_FILE` at startup. Invalid configuration aborts startup. Production (`NODE_ENV=production`) requires true; invalid mode values never silently select local mode. The trust epoch in `REMEDY_REVIEWER_TRUST_EPOCH` must match the keyring. No real key is supplied by this repo.

The keyring is JSON `{issuer,audience,environment,trust_epoch,keys:[...]}`. Each key has exactly its pinned policy: `kid,issuer,audience,environment,trust_epoch,kty,crv,x,not_before,not_after,enabled,revoked_at`. Public JWK `x` is canonical base64url; private key fields are forbidden. Production rejects the public fixture key and ID. Use a new ID after revocation. Native Node crypto verifies received segments with the exact `Ed25519` header; no algorithm alias or remote discovery.

Service key file format is 64 lowercase hex characters, optionally one LF. Requests use exactly one `X-Remedy-Service-Key` header. Required mode authenticates every path except GET liveness, including unknown paths and preflight. Static panel is unavailable. Strict JSON rejects duplicate decoded names, malformed UTF-8, lone surrogates and excess depth before handlers run. Browser clients must use Conductor; they must never receive service keys.

During this first slice all required-mode HTTP mutation aliases return 503 `signed_writer_unavailable`. `/readyz` reports `mutate:false,operation_status:false`; it cannot claim production readiness. Existing explicit local mode remains scoped by loopback and the owner sandbox. `/healthz` is liveness only in every mode. The deployment must use authenticated capability readiness, never infer write readiness from liveness.

This slice does not certify durable dispatch, signed HTTP writes, the upstream signer/forwarder, production topology or a full-stack release. Those stay tracked by LT-1/LT-113/LT-111. LT-122/123/124, dependency advisories and request/resource lifetime gates remain open. No live services, real credentials, public bridge/tunnel, or direct public panel are part of this work.
