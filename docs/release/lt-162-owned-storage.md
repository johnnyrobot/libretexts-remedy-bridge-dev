# LT-162 owned browser storage

The per-job storage policy is in [the scanner guide](../../browser-scanner/README.md#owned-temporary-storage-lt-162).
This focused change preserves f39566e's cxone-review-v1/cxone-terminal-v1,
both-profile read-health behavior, production mutation hold, and all Bridge
SDK/worker/ledger contracts. The exact LT-197 verified Server delivery at
20a09894895d8c5df69a6d2c2bb1adbbe08f22c2 is preserved; this new source requires a
separate Server LT-212 package refresh and assembled acceptance.

## Diagnosis and choice

A real sandboxed Chromium cancellation under Node22/macOS left 82,386 bytes in
48 entries after process termination and admission reuse. The red lifecycle
assertion expected zero retained entries. Installed Playwright1.63.0
`playwright-core/lib/coreBundle.js` `_prepareToLaunch` creates
`playwright-artifacts-*` and `playwright_chromiumdev_profile-*` under
`os.tmpdir()`. `launchProcess` removes them from its worker-side close callback;
SIGKILL of that worker bypasses the callback. No dependency change is needed.

The parent creates one private job root before launching the worker, passes
it as all temporary/home/cache locations, retains its device/inode/UID identity,
and removes only that exact root after worker close and verified tree termination.
In the original PR27 implementation, the independently acknowledged Chromium
root and late ownership messages remained owned through teardown. That historical
raw-inventory algorithm froze and reinventoried descendants until stable,
including children that fork into another process group during inventory. A PID
disappearing during that initial Linux inventory, or an unfrozen discovered
descendant disappearing before the next freeze, made ownership uncertain. Known
groups were still stopped; cleanup/admission remained held because a fork-and-exit
could have left an unidentifiable orphan. LT-225 replaces that shipping Linux
decision with the kernel guardian described below; the generic/macOS raw helper
stays conservative. Uncertain termination still never reaches storage cleanup.

128 MiB and8,192 entries are conservative sampled stop thresholds, inspected every
250ms using the larger logical/allocated size for every entry. The128MiB budget
provides8x the16MiB maximum result message and16x the8MiB reader DOM; neither
comparison claims a universal Chromium working-set limit. Small synthetic reader
cancellation measured about83KiB logical/148KiB allocated in50entries on macOS;
Linux measurements belong to the exact CI run. The shipping512MiB tmpfs is the
hard aggregate cap and leaves384MiB beyond the stop threshold for sampling
overshoot and other isolated runtime needs. Admission requires256MiB available.
Shared-memory1GiB, totalmemory2GiB,256PIDs,1.5CPU and120s lifetime are preserved.
Unsupported arbitrary host filesystems cannot claim the same hard storage bound.

A failed inspection stops work. A denied/failed cleanup, identity change,
unacknowledged startup, or retained over-budget root keeps admission busy and
retains the directory. There is no global/sibling sweep, restart cleanup,
process-termination bypass, host permission broadening or sandbox relaxation.

## Verification and evidence

The lifecycle suite uses real processes and sandboxed Chromium; only external
DNS and reader content are synthetic. It covers repeated disconnect, worker
SIGKILL, shutdown, normal completion, concurrent scanner isolation, actual OS
cleanup denial, oversized storage, uncertain pre-ack startup and the real120s
Linux deadline. Byte/allocated-byte/entry measurements follow observed reaping;
Linux asserts disappearance of the observed PIDs, including zombies. A separate
Linux fixture deterministically forks a detached descendant after the first
process inventory: a surviving intermediate parent permits verified termination;
the fork-and-exit variant must refuse certainty. The fixture explicitly kills its
remaining synthetic orphan after that refusal. Browser test files run serially
to avoid unrelated fixture process churn; the isolation case explicitly runs two
scanners concurrently.

Local raw red/green and failed initial harness runs are preserved in
`.scratch/lt162-evidence/` and `/tmp/lt162-*.log`. Early harness failures were an
already-disconnected IPC cleanup call, a wrong test working directory and a
mechanical syntax replacement; those test errors are retained, not product
passes. Initial broad Bridge tests under host load failed20/546, predominantly
5/8s startup deadlines and their cascading assertions; focused provider-policy
rerun passed3/3. Final results and exact Linux/main workflow URLs are recorded in
the PR and handoff. No Linux success is inferred from macOS tests.

No live library/provider, credentials, deployed service, upstream repository,
TestSprite run or production enablement is part of this work. Existing dormant
SDK advisory inventory and release-owner acceptance limitations remain unchanged.


## LT-225 correction to the original global-inventory decision

The initial PR27 global `/proc` disappearance rule described above is historical
for Linux shipping jobs. Controlled Linux evidence showed the same missing-row
category can represent an unrelated sibling OR a reaped owned descendant with a
live escaped child. Ignoring that category would be unsafe. The raw helper stays
conservative for its generic/macOS diagnostic callers.

Linux scanner jobs now use the [private per-job kernel guardian](../../browser-scanner/README.md#linux-job-process-ownership-lt-225).
It verifies child-subreaper ownership before spawning work and never reaps direct/
adopted PID identities before signaling. Only kernel `ECHILD` after teardown,
received through the guardian-only channel and clean process exit, can certify
that no descendants remain. Worker-supplied fields cannot forge this proof. An
uncertain partial IPC send closes its channel; no terminal JSON is appended to a
truncated prefix. Negative proof keeps a bounded reason; absent proof holds too.
All root-identity/storage checks and finite limits remain. The ownership seam
itself does not resolve allocation availability.

## LT-224 proven storage-free refusal

The allocator privately records only two failed-allocation outcomes: `no_root`
for the free-space check before `mkdtemp`, and `removed` after a failed home mkdir
and positively verified removal of that exact root. The server consults this
private object-identity record before releasing admission. Error names, codes,
messages and caller fields cannot manufacture it. No worker exists at this point.
The public 503 response is unchanged; insufficient space still prevents scans
until an actual retry succeeds. Liveness/idle status is not scan readiness.

Failed `mkdtemp` (including partial creation), unreadable root identity, failed
cleanup or root replacement has no release proof and keeps busy503. The server
never sweeps sibling or global temporary data. Kernel uncertainty, oversized
retained jobs and production write holds remain unchanged. The Linux regression
uses real allocated fixture blocks under the existing 512 MiB tmpfs, actual OS
mkdir denial, same-process real Chromium retry and conservative failure cases.
