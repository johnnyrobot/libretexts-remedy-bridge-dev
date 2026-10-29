# Bounded Bridge work (LT-153)

Read/scan/preview routes run in separately owned Node processes. The parent owns
admission, all live preview tokens and signed mutation state. HTTP cancellation
or total deadline kills the read process, waits for actual close/reaping, and
only then releases capacity. Child results cannot admit a token after abort.
Native Sharp work and JSDOM/axe CPU work die with that process. Health runs in
the parent without waiting for admission. No HTTP/environment switch selects an
inline executor; existing in-process regression tests explicitly construct an
adapter while actual default-route process tests verify the deployed adapter.

Default limits (configuration may lower them, never raise them or disable them):

| Resource | Default/maximum | Configuration |
|---|---:|---|
| Active owned jobs | 2 | `REMEDY_WORK_ACTIVE` |
| Queued read/preview jobs | 8 | `REMEDY_WORK_QUEUED` |
| Total elapsed time, including queue/body/retries | 300 seconds | `REMEDY_WORK_TIMEOUT_MS` |
| HTTP request body | 5,000,000 bytes | `REMEDY_MAX_REQUEST_BYTES` |
| SDK/provider decoded response | 8 MiB | fixed |
| Per-preview combined before/after HTML | 8 MiB | `REMEDY_PREVIEW_MAX_BYTES` |
| Aggregate retained previews, including diff/metadata | 64 MiB | `REMEDY_PREVIEW_BYTES` |
| Aggregate live preview tokens across all kinds | 128 | `REMEDY_PREVIEW_ENTRIES` |
| Preview TTL | 30 minutes | `REMEDY_PIPELINE_PREVIEW_TTL_MS` |
| Read worker JS heap | 384 MiB | fixed |

Existing per-image transport10MiB,40-million-pixel and single-frame limits still
apply; each worker disables Sharp's retained cache and limits native threads.
Heap bounds do not include native allocations. Deploy the bridge with the tested
2GiB/2CPU/256PID container envelope. This permits OOM failure rather than
unbounded host use; a failed worker returns sanitized unusable evidence. It is
not a claim that every permitted8MiB document fits the heap or is scannable.

Cache accounting includes serialized retained metadata. Expiry is pruned before
admission; pressure rejects503 rather than evicting an unexpired reviewed token.
Revising consumes the old token before work, including when revision fails.
Caches remain ephemeral; restart requires a new preview, while durable consumed
nonce/token and unknown-target protection stay in the ledger.

Mutations never enter the read queue. Lack of global/target capacity rejects
immediately. Eligibility and signed authorization are rechecked before dispatch.
The total signal aborts pre-dispatch reads and prevents late dispatch. After the
durable dispatch marker, the single remote mutation retains its independent30s
bound and no retries; disconnect/shutdown cannot abandon durable known/unknown
finalization. The owner/ledger lock stays held until actual completion. Filesystem
failure can keep ownership while admission fails closed; a timeout is not proof
of no remote write. Production `conditional_write_unproven` remains enforced.
Saturation returns503 with `Retry-After: 5` and sanitized errors.

SDK and provider response streams are counted before concatenation/JSON parsing,
including chunked and decoded compressed responses. The guarded SDK compatibility
patch installs the pinned Axios fetch adapter and the shared policy in ESM/CJS.
Provider retry waits observe the same total signal. The original SDK mutation
UTF-8, no-redirect,30s controls remain in force. No automatic SDK write retry is
introduced.

The rendered scanner has its own owned POSIX process group,120s total deadline,
5s/4096-byte body bound and one active job with immediate503 backpressure. Client
loss/shutdown kills owned groups including Chromium, and capacity remains owned
until termination is confirmed. A public loopback-only Playwright server reports
its browser PID and awaits a parent ownership acknowledgement before loading
authored content. Abnormal worker exit reaps that independently retained browser
root; a startup death before ownership is established keeps admission busy until
an operator restarts the isolated container. No uncertain ownership is released. It runs non-root with Chromium sandbox enabled and
the committed seccomp profile. Preserve2GiB/2CPU/256PID/1GiB shared-memory limits
from CI/deployment. It rejects more than64 configured resource hosts,256 resource
responses,8MiB serialized reader DOM and16MiB result messages. Browser/native
resource transfer itself remains bounded by the container envelope and lifetime,
not a claimed per-download streaming byte limit. Network loss can delay remote
cancellation; the scanner keeps its own slot until its process actually stops.

## Dependency inventory and provenance

`evidence/lt-153/npm-audit-production.json` retains the exact npm production
inventory: **2 high findings** (SDK package and its nested Axios chain), not an
advisory-free artifact. SDK1.7.0 declares nested Axios1.18.0 and also embeds old
Axios in its ESM/CommonJS bundles. These files remain present. The guarded
postinstall rewrites both request-instance creation sites in both bundles to
external pinned Axios1.21.0; actual ESM/CommonJS wire and request-factory tests
prove that route. No downgrade, override-only claim or ignored advisory is used.
The copied dormant nested/embedded code remains a supply-chain maintenance debt;
other consumers importing it directly are outside this reachability evidence.
Release installation must execute postinstall, and an SDK layout/version change
requires patch review. This is local compatibility work, not a vendor security
release.

## Verification scope

Actual default HTTP children plus fake external transport cover2+8 overload,
mutation backpressure, slow SDK/body, disconnect/socket close, CPU-heavy scan
termination, slot reuse, health and shutdown. Real local SDK/provider wire tests
cover oversized chunked response, retry budget and post-dispatch cancellation.
Existing signed durability/auth/production-hold and native decode suites remain
required. Linux image CI runs the product tests with networking disabled and
finite cgroup resources; a separate image runs actual sandboxed Chromium.
No live/provider call or canary is needed for these probes. TestSprite has no
Bridge project/authorized remotely reachable target; the loopback staff boundary
prohibits exposing this API through a tunnel. No TestSprite verdict is claimed.
Cross-stack candidate verification and current vendor atomicity remain release
gates under LT-111/LT-154.
