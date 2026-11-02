# Rendered reader-page scanner

This separate Playwright/Chromium service evaluates the full public reader page with axe-core WCAG 2.1 A/AA tags. It does not contain CXone write credentials or inference keys. The browser runs as `pwuser` with the Chromium sandbox; the included Playwright seccomp profile permits user namespaces. Use the private Docker network only; do not publish port 5180.

Copy `compose.example.yml` to the deployment compose file. Create a mode-600 `browser-scanner.env` containing a generated `RENDER_SCANNER_TOKEN`. Set that same token and `RENDER_SCANNER_URL=http://remedy-browser-scanner:5180` in the Bridge environment. `RENDER_ALLOWED_HOSTS` is an explicit comma-separated resource-host allowlist. Every allowed host is resolved to a public IPv4 address and pinned for each browser lifetime; all other DNS names and non-GET/HEAD requests are blocked. Resource blocking is reported as incomplete evidence, not silently ignored.

`POST /scan` accepts `{ "url": "https://dev.libretexts.org/Sandboxes/johnnyphung/..." }` with Bearer authentication. Requests outside the sandbox are rejected. Only one scan runs at a time (503 with `Retry-After: 5` while busy). MathJax v2 queues and v3/v4 startup promises are awaited. Missing reader content, redirects outside the page, MathJax errors and timeouts fail closed. The result records browser/axe versions, viewport, source-independent rendered content and script/CSS hashes, load errors, axe violations/incomplete results and rule coverage.

Bridge's existing `/v1/cxone/page/scan` accepts `rendered: true`; the gateway forwards this field. A source-only scan preserves browser evidence only when the source hash is unchanged. Browser evidence supersedes a source axe execution error only if MathJax is ready and the browser explicitly passed that rule (or found it inapplicable). Original execution errors remain in `resolvedSourceChecks`. An incomplete full-page load adds an explicit readiness finding and still blocks Conductor sign-off, even when an individual rule completes. Confirmed source failures remain open.

Browser scans are evidence, not certification. Screen-reader math semantics, exploration, duplicate speech, keyboard operation, complete processes, visual and linguistic review still require human testing. Resource hashes conservatively invalidate reviews when relevant rendering changes. Future page changes cannot be detected until rescanning; Conductor requires scans within 24 hours for current sign-off.

Validation: `npm ci && npm test` in this directory; Bridge integration tests run in the core workspace. The seccomp profile is from Microsoft Playwright v1.63.0 (`utils/docker/seccomp_profile.json`).

## Duplicate initialization

Copied pages can contain a MathJax initializer in addition to the reader's platform initializer. A live-page fixture comparison reproduced a pending MathJax 4 startup promise with two loaders and successful startup with one. `node tools/repair-mathjax-initializer.mjs <sandbox-page-url>` previews a guarded cleanup; add `--apply` to write with a restore snapshot. It requires exactly one authored loader and two matching rendered loaders, allowing only the known copied 0.85/platform 1 scale difference. Custom configuration is retained for manual review. Equation markup and CSS are preserved byte-for-byte; this does not verify mathematical meaning or speech quality.

The worker identifies itself as `LibreTexts-Remedy-Accessibility/1.0`; some reader deployments reject the default HeadlessChrome user agent. The actual CXone article selector is `section.mt-content-container`; the header's optional login form does not imply that the article requires authentication. MathJax timeouts retain partial axe evidence and explicit readiness errors. Blocked write/telemetry requests are recorded separately from blocked read resources; write-based processes still require reviewer tests. Render fingerprints include the reader shell and loaded image/font/script/CSS assets.

Run native MathML regression tests inside the worker container with `RUN_BROWSER_TESTS=1 npm test`. They exercise fractions, exponents and hidden MathML while confirming real invalid ARIA still fails.

## Owned temporary storage (LT-162)

Each admitted job receives a new private mode-700 directory. The worker's
`TMPDIR`/`TMP`/`TEMP`, Chromium home and XDG cache/configuration all point inside
that directory. Playwright's generated profile and artifacts therefore remain
owned by that job even when SIGKILL bypasses its launcher cleanup callback.
Installed browser lookup is resolved before changing the worker's home.

The parent checks storage every 250 ms: at most 128 MiB (the sum of each entry's
larger logical or allocated size), and 8,192 entries. Crossing either threshold
or failing inspection stops the job. These are sampled stop thresholds: writes
can overshoot between inspections. The **512 MiB `/tmp` tmpfs** in the compose
example, shipping stack and Linux CI is the hard aggregate allocation ceiling;
the 2 GiB memory, 256 PID, 1 GiB shared-memory and 120-second limits still apply.
Admission requires at least 256 MiB available on that filesystem. Arbitrary host
filesystems without an equivalent finite quota do not provide this disk bound.

Admission stays occupied through worker close, verified termination of owned
process groups, and verified removal of the exact job directory. Cleanup never
discovers or sweeps sibling/global temporary directories. Root replacement,
foreign ownership, unreadable state, cleanup failure, over-budget retained
storage, or unacknowledged browser ownership leave admission closed and storage
retained; `/healthz` remains live with `busy:true`. Repeated requests cannot
allocate more jobs in that process. Preserve retained directories for isolated
container/operator diagnosis; restarting is not evidence that they were cleaned.

Before any worker exists, a refusal for insufficient free space creates no job
root and leaves admission idle. It still returns 503 on every attempt until the
256 MiB free-space floor is met; only a successful real scan proves recovery.
Likewise, failure to create the job home can release admission only after exact
owned-root removal is positively verified. These are private allocator outcomes,
not error-message or caller-provided markers. Failed `mkdtemp`, unreadable identity,
partial allocation, root replacement and denied/unproved cleanup keep the hold.
`/healthz` is liveness: `busy:false` alone does not certify available disk space
or a successful scan. Never delete retained roots to manufacture readiness.

The Linux lifecycle suite exercises the actual sandboxed browser with synthetic
external DNS/content and no external networking, including repeated cancellation,
worker SIGKILL, the full 120-second deadline, shutdown, concurrent-job isolation,
OS cleanup denial and a late detached descendant. It measures bytes and entries
after observed reaping. These component checks do not enable production writes
or replace the assembled-package acceptance owned by Remedy Server.

### Linux job process ownership (LT-225)

The Linux image uses its existing Python 3 runtime for a private, unprivileged
per-job guardian. It sets and verifies child-subreaper status before creating the
Node worker, with no-new-privileges and the existing seccomp policy. Orphans stay
kernel-owned by that guardian even after `setsid`, worker SIGKILL, or parent exit.
It signals only its own direct/adopted children and does not reap their PID
identities before signaling. Only kernel `ECHILD` after termination certifies
that the job has no remaining descendants. PID-fd support is not assumed: the
current policy refuses that probe, and the guardian uses unreaped-child lifetime
instead, without relaxing seccomp or adding capabilities.

The worker cannot inherit the guardian's private parent channel or supply its
terminal proof. Missing/failed guardian proof, inspection failure, cleanup denial,
unacknowledged startup or retained over-budget storage still leaves admission
closed and the exact root retained. The 120-second total timer, worker heap,
aggregate/per-job storage, CPU/memory/PID limits and 30-second stop policy remain.
macOS retains the previous conservative process handling; the shipping proof is
Linux. This does not change public HTTP contracts or enable production writes.

## Operator public CA trust (LT-239)

`RENDER_PUBLIC_CA_FILE` is an optional **service-level operator setting**, supported
only by the shipping Linux image. Unset or empty preserves Chromium's default
platform trust. The HTTP request still selects only the permitted page URL;
request/page/learner data cannot select a CA, file, trust store or tool.

The deploying service owner may mount **one approved public root-CA PEM bundle**
as a regular file, for example `/run/remedy-public-ca/roots.pem`, read-only into
the renderer. Use an absolute path, no final symlink, mode **0444** (or **0400**
with an owner readable by the selected nonroot UID). The file must have **no write
permission bits**. Its containing directory/mount must be operator-controlled;
use a read-only file bind mount, not a writable parent-home mount. No private key,
client certificate, cookie, user profile, NSS seed directory or issuer fetched
from a page belongs in this input. Only self-issued, signature-verified certificates
with CA basic constraints are accepted. Intermediate and leaf certificates are
rejected. The operator remains responsible for selecting which roots to trust.

Limits are **65,536 input bytes**, **8 distinct certificates**, and **1 MiB / 32
entries** for completed trust setup, including its input copy, PEM import files,
NSS files and public hash record. Empty, missing, unreadable, writable, nonregular,
malformed, mixed/key-containing, duplicate and over-limit configured inputs fail
service startup before a listener or job exists. Startup captures the bounded
input once. Changing it requires a controlled service restart; it cannot mutate
admitted or later jobs in that process. No parent keystore is opened or cloned.

For every admitted job the parent writes the captured public PEM as mode-0400
`$RENDER_JOB_HOME/operator-public-ca.pem`. The private parent/worker channel binds
its SHA-256; the worker rereads and verifies that exact finite snapshot. It creates
fresh mode-0700 `$RENDER_JOB_HOME/.pki/nssdb`, initializes a new SQL NSS database
with `/usr/bin/certutil -N --empty-password`, and imports each root with
`-A -a -t 'C,,'`. Canonical per-certificate PEM inputs and `public-ca.json` stay
under `.pki`. NSS generates `cert9.db`, `key4.db` and `pkcs11.txt`; **no private key
is imported**. `key4.db` is the newly initialized empty NSS key database.

[Chromium's Linux certificate documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/cert_management.md)
specifies that M146+ defaults to `$HOME/.local/share/pki/nssdb` and reuses an
existing `$HOME/.pki/nssdb`. We deliberately create the legacy path before browser
startup, supporting that documented lookup without maintaining two writable DBs.
The worker's HOME/XDG paths still point only to its own fresh job home. Importing
local anchors is additive; the platform/root store, TLS verification and hostname
checks are unchanged. No certificate-error or sandbox bypass is used.

Trust tools run **inside the existing worker's guardian ownership**, with a
5-second limit per command, finite captured output, and the same 120-second total
job deadline. The parent monitors the entire job, including setup, against the
existing 128 MiB / 8,192-entry thresholds. The 1 MiB / 32-entry trust check occurs
before navigation; the existing **512 MiB tmpfs is the hard aggregate ceiling**,
including writes between checks. Setup failure can release capacity only after
positive guardian termination and exact-root cleanup. Cancellation without browser
acknowledgement, lost proof, uninspectable/over-budget storage and failed cleanup
retain the existing conservative hold. Setup has no independent cleanup sweep.

Scanner results add `publicCATrust: { sha256, fingerprints }` for the exact
operator input (SHA-256 of the original UTF-8 PEM bytes and certificate SHA-256
fingerprints); it is `null` when unconfigured. This is provenance, not permission
or evidence of conformance. Service authentication and URL/private-network policy
are unchanged. Existing consumers preserve the additive result field.

The verified shipping target is Linux **amd64**, Playwright **1.63.0**,
Chromium **153.0.8010.12** at
`/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.
The Dockerfile pins the observed base
`mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`
and `libnss3-tools=2:3.98-1ubuntu0.3`. The existing runtime stays
`libnss3=2:3.98-1ubuntu0.2`; `/usr/bin/certutil` SHA-256 is
`505b13e3087e1abcabec3f1485e0e76b81322667dcae25758341b46bcfc5b62d`.
[The first green Linux proof](https://github.com/johnnyrobot/libretexts-remedy-bridge-dev/actions/runs/41441910329)
records Node24.20.0 and all39 renderer cases passing with zero skips. The final
exact-head/main records belong to the PR/handoff. No other NSS/browser/architecture
pair is certified by this proof.

The image supplies the NSS tool beside its existing runtime library; its build
must retain the base `libnss3` version. Exact base, tool/runtime package versions,
tool hash and actual Chromium version are recorded in the Linux HTTPS proof.
Host-generated NSS databases and arbitrary host NSS versions are unsupported.
The exact already-reviewed Server stack seccomp policy is retained as
`shipping-seccomp-amd64.json` (SHA-256
`fcecf1a0ae6f84effa439b44d5f0e51bc25b4a975a7025c71e6f9ee0490ca7b0`);
the original `seccomp_profile.json` remains unchanged. Shipping CI uses the former
with UID1001, cap-drop ALL, no-new-privileges, init, read-only root, network-none,
finite tmpfs/shm/memory/CPU/PIDs and 30-second stop policy. The stack policy's
existing namespace-local chroot allowance remains kernel-denied in the initial
unprivileged namespace. No new host policy allowance is introduced here.

For Server LT-212: consume the reviewed immutable source pin, rebuild the renderer
from this directory, mount only the public PEM read-only and set
`RENDER_PUBLIC_CA_FILE` to its absolute container path. Remove dependence on a
parent HOME/NSS seed for this renderer; this implementation never reads that seed.
The Server owner must review its own configuration/preflight change and rerun the
assembled HTTPS/consumer/lifecycle acceptance. Component proof does not accept the
assembled package, clear LT-227, enable production writes or alter the preserved
original acceptance/archive.
