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
