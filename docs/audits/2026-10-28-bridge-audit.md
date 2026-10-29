# Remedy Bridge audit — 2026-10-28

Ticket: [LT-99](https://linear.app/johnnyrobot/issue/LT-99/audit-libretexts-remedy-bridge-architecture-reliability-performance). Repository: [johnnyrobot/libretexts-remedy-bridge-dev](https://github.com/johnnyrobot/libretexts-remedy-bridge-dev). Audited `main` at [063d399501de072c592e7e8d83326167303fcf5c](https://github.com/johnnyrobot/libretexts-remedy-bridge-dev/tree/063d399501de072c592e7e8d83326167303fcf5c). Local date is Pacific; evidence timestamps use UTC and therefore show October 29.

**Recommendation: make target identity and reviewed output inseparable from a write, then make claiming a preview atomic.** The current allowlist can check one target while writing another, and the panel has paths that recompute an unreviewed result. Concurrent apply/restore can execute twice. These deserve a small correctness slice before broader refactoring or throughput work.

No confirmed application defect was classified critical. Seven major findings follow; dependency advisory severities are reported separately from demonstrated application exploitability. During the original audit, no application files, dependencies, configuration, glossary, or ADR were edited; no commits, pushes, PRs, paid reviews, live CXone/library/ADAPT calls, or teammate-repo changes were made, and the starting and ending tracked trees were clean.

**Archive status:** this version-controlled Markdown report is the documentation archive. Findings, measurements and source locations below describe the audited SHA, not fixes or fresh verification during archiving. All acceptance criteria and follow-up scopes remain proposed and unimplemented. Raw evidence, executable probes, authored TestSprite plan files and HTML previews remain **local-only**, excluded from this archive; filenames below identify those records, not downloadable GitHub artifacts.

## Method and scope

Read shared `CLAUDE.md` and all four `docs/agents/` rules, README, relevant package/build/test definitions, and `docs/adr/0001-loopback-reviewer-attribution.md`. Applied **ask-matt → improve-codebase-architecture + codebase-design**, including the required separate read-only exploration subagent. This is use of Matt Pocock's written skills, not a consultation with Matt personally. Read both repository TestSprite onboard/verify skills. Chief selection replaces the skill's default user interview; no candidate was implemented or interface designed.

Sampled the last 20 commits. Recent concentration: browser scanner (5 touches), tag write/restore (3), guarded HTML writes, rendered evidence, and panel routes (2 each). The last application change is reviewer attribution/loopback enforcement (#10); #11 only disables automatic reviews. Explored those hotspots, the panel's actual Local Lab/Production flows, CXone adapter, image fetches, LLM retry/queue behavior, snapshots, scan execution, CI and Docker definitions.

Detailed evidence is retained locally in `docs/audits/2026-10-28-evidence/`; it is not committed or linked from this archive. The following describes the original offline probes, not instructions to run them.

`route-probe.cjs` transpiles the unchanged route source into an isolated context, replaces the HTTP listener and core functions with fake adapters, and prevents dotenv reads. It opens no socket. `core-probe.mjs` uses the built core, fake SDK methods, fake keys, new temporary snapshot files, and a fetch function that refuses every network request. These prove implementation interleavings and contracts; they are **not end-to-end or TestSprite verification**. Temporary synthetic files were retained; existing work was preserved.

## Ranked findings

| Rank | Finding | Severity / confidence | Impact | Effort estimate |
|---|---|---|---|---|
| F1 | Guard checks asserted path, writer uses independent ID/input | Major / high | Owner-sandbox restriction can be bypassed by mismatched manifest metadata | Small–medium |
| F2 | Preview identity and one-time use are inconsistent | Major / high | Unreviewed output/target, duplicate revisions/restores, ambiguous retry outcomes | Medium |
| F3 | Image fetch guard accepts mapped private IPs and does not guard redirect hops | Major / high | Content-controlled outbound requests can reach excluded destinations | Medium |
| F4 | Concurrent axe scans silently lose findings | Major / high | Parallel requests can look cleaner than the identical serial scan | Small–medium |
| F5 | Tag snapshots enter HTML restore selection | Major / high | Normal mixed-operation history breaks default recovery | Small |
| F6 | Known dependency findings, including runtime image/transport dependencies | Major / high for presence; exploitability varies | Conditional Linux image-decoder risk and vulnerable transport/tooling dependencies | Small–medium, SDK coordination |
| F7 | No request-wide cancellation/deadline or shared admission budget | Major / high for missing controls; medium for workload impact | Stalled dependencies and concurrent jobs can retain work/resources indefinitely | Medium |

Estimates describe likely scope, not implementation commitments.

### F1 — Canonical target identity is not enforced at the writer

`packages/core/src/write-tags.ts:249` constructs a page from the manifest's independently supplied `sandboxPageId` and `sandboxPath`. `writePageTags` authorizes the path at line 117, then fetches/writes tags using only the ID at lines 119/141. No canonical page lookup ties them together. A stale or incorrect manifest can label ID 999 as an allowed sandbox path even when that ID belongs elsewhere on the configured host.

The public HTML writer has the same shape: `packages/core/src/write-page.ts:58` checks `page`, but lines 73–74 post to independent `pageInput`. Existing normal callers resolve their metadata first, so this second case proves a writer-contract gap, not an observed malicious HTTP request.

**Executed evidence:** `core-results.json` records manifest status `written`, calls `getTags(999)` and `putTags(999)`, with no `resolve` call, despite the fake canonical path for 999 being `Bookshelves/Outside`. The HTML probe checks page ID 42 and calls `postContents(999)`. All writes were fake.

**Acceptance:** resolve the canonical target before authorization; authorize and write that same identity; reject mismatched ID/path/input before snapshot or mutation; prove both manifest and HTML entry points with fake adapters. Keep the owner-sandbox restriction and caller-asserted attribution policy intact.

### F2 — Reviewed previews are not a consistent write contract

Three related defects belong in one guarded revision module:

* **Panel:** `packages/conductor-panel/src/tabs/Production.tsx:44` confirms `preview.pagePath`, but line 47 submits mutable `pageInput` and `tier`; the input/select at lines 64/66 do not invalidate the preview. `src/api.ts:47` sends only page/tier. `server/server.ts:544` starts a fresh `runPipeline(...mode:'apply')` without a token or preview hash. Preview A/Tier 1, edit the controls to B/Tier 3, and confirmation still describes A while apply processes B. Even unchanged controls can generate different AI output than the reviewed diff.
* **Tokenless compatibility path:** `server/server.ts:479` recomputes a preview, checks its before hash, then line 491 calls `fixPage` again in apply mode. The second generation is not the reviewed output and may read a newer page. A source hash alone does not bind generated output.
* **Concurrent use:** targeted and pipeline sessions are deleted after awaited writes (`server.ts:396,460`). Restore reads its session before awaited resolution and only deletes afterward (`server.ts:178–186`), so moving deletion before the final write has not made the claim atomic.

**Executed evidence:** `route-results.json` shows two HTTP-handler responses of 200 and **2 fake writes** for one token, and two 200s/**2 fake restores** for one restore token. Tokenless apply calls `fixPage` with `preview` and `apply` separately. Panel calls record preview A/Tier 1 followed by apply B/Tier 3. The probe uses the actual route code with fake core implementations, so it does not claim that any live revision was created.

**Error handling:** `write-page.ts:73` mutates remotely before `appendAudit` at line 83. `core-results.json` shows one successful fake post followed by `EISDIR` from an unwritable audit destination. The route can return 500 without consuming its preview, leaving a successful write presented as a failure. A response loss has similar ambiguity. Do not add automatic write retries without resolving this outcome problem.

**Acceptance:** panel and compatibility routes use the reviewed output and canonical target; changed inputs invalidate review; token claim happens synchronously before any await, with per-page serialization for distinct tokens; concurrent replay creates at most one mutation; stale source fails closed; response-loss/audit-failure states distinguish known success from unknown outcome and cannot blindly replay. A local lock alone cannot exclude outside editors: verify CXone's supported conditional-edit semantics before claiming external lost-update protection (`write-page.ts:77` currently uses `edittime:'now'`).

### F3 — Deepen the image-fetch implementation, not just its predicate

`packages/core/src/net-guard.ts:127` recognizes only dotted IPv4-mapped IPv6. The URL parser canonicalizes it to hexadecimal. **Executed:** both `http://[::ffff:127.0.0.1]/x.png` and `http://[::ffff:169.254.169.254]/x.png` return `{ok:true}`; plain IPv4 loopback is rejected (`core-results.json`). No internal target was contacted.

`image-availability.ts:130` and `ai/llm-client.ts:610` call fetch after checking only the initial URL. Redirects use fetch's default following behavior; later destinations are not revalidated. The byte-fetch path has no abort signal or encoded-byte budget before `arrayBuffer()` at line 612. `sharp`'s 40-million-pixel limit at line 624 limits decoded pixels, not downloaded bytes. DNS resolution is explicitly excluded by the current predicate (`net-guard.ts:17`), so rebinding protection must not be claimed.

**Acceptance:** reject mapped private/loopback/link-local forms; enforce policy on every redirect and resolved destination; bound redirects, headers/body time, encoded bytes and decoded pixels; cancellation reaches image fetches; blocked images never reach inference. Native fetch and a deterministic fake adapter justify a real seam. Treat private-DNS/redirect exploitability as source-supported risk, not an executed network exploit.

### F4 — Concurrency hides axe failures

The shared axe import in `packages/core/src/scan-axe.ts:4` is reused with different JSDOM documents at lines 98–124. Three concurrent raw calls produced one result and two `axe.run arguments are invalid` rejections in the independent exploration. `scanHtmlFull` swallows these at `scan.ts:99` and returns deterministic-only findings.

**Executed public-interface evidence:** `<button></button>` yields `['axe/button-name']` serially; the same three simultaneous `scanHtmlFull` calls yield `[['axe/button-name'],[],[]]`. The latter two results carry no engine-failure indication. See `core-results.json`.

**Acceptance:** identical parallel/serial fixtures produce identical evidence, using safe isolation or serialized axe execution; an engine failure remains explicit and blocks a clean result; close JSDOM windows after success/failure; test callers through `scanHtmlFull`, not only the axe helper. Do not introduce a throughput pool that reproduces the silent downgrade.

### F5 — Recovery confuses tag and HTML snapshots

Tag snapshots are written beside HTML snapshots as `*.tags.json` (`packages/core/src/write-tags.ts:91`), with metadata nested under `meta`. `guardrails.ts:219` treats every JSON file as HTML metadata; `revert.ts:96–111` chooses the newest and attempts its nonexistent `.tags.html`. This also pollutes panel `/snapshots` output with undefined timestamp/hash fields (`server.ts:161`).

**Executed:** save HTML, apply fake tags, then default `revertPage(...dryRun:true)` fails with `ENOENT` on `.tags.html`. The documented explicit `.html` snapshot path (`revert.ts:31`) also fails JSON parsing because `readSnapshot` treats it as the metadata path (`guardrails.ts:237–240`). The latter is a minor contract bug within this major recovery finding.

**Acceptance:** select only valid HTML snapshot pairs for HTML restore; preserve tag restore separately; validate kind, identity, hash, and paired-file presence; both documented explicit path extensions work; mixed histories, malformed metadata, missing pairs and stale preview tests fail safely. Preserve the pre-restore recovery snapshot.

### F6 — Dependency maintenance needs targeted changes

Package-registry audit results are saved as `npm-audit*.json` (no credential output). All-dependency audit: **10 affected packages: 2 critical, 6 high, 2 moderate**; production-only: **4 high**, no critical. These are package counts, not ten independently demonstrated application exploits. The separate browser-scanner lockfile audit reports zero findings.

| Installed | Evidence | Assessment / proposed next action |
|---|---|---|
| sharp 0.35.4 | `packages/core/package.json:37`, lockfile:3686 | A maintainer advisory affects versions below 0.35.5; certain glibc Linux runtime conditions permit RCE. Actual image bytes reach `sharp` at `llm-client.ts:624`. Prioritize 0.35.5 compatibility verification for the Linux image. The Mac run does not demonstrate Linux exploitability. [Maintainer advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w). |
| SDK 1.7.0 / axios 1.18.0 | `packages/core/package.json:30`, lockfile:2479 | Multiple transport advisories. Installed SDK `dist/index.mjs:1591` embeds axios 1.18.0, so updating a hoisted axios alone cannot be assumed to repair the SDK. `tools/patch-cxone-utf8.mjs:11` deliberately rejects other SDK versions; any upgrade must review that patch and retain ESM/CJS UTF-8 wire tests. Do not accept npm's suggested SDK downgrade to 1.4.0 blindly. |
| follow-redirects 1.16.0 | lockfile:2983 | Registry flags credential-stripping advisories; determine the selected SDK adapter and header usage before claiming this exact path is exploitable. |
| concurrently 9.2.4 → shell-quote 1.9.0 | lockfile:2668,3747 | Registry marks these critical. The maintainer says exploitation requires attacker-controlled line terminators after a comment token. Current package scripts are fixed literals; no such attacker-controlled script path was found. Patch/update tooling rather than label the application remotely exploitable. [Maintainer advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv). |
| Vite 6.4.3, Vitest/mocker 4.1.11, source-map-js 1.2.1 | lockfile:4015,4574,3767 | Dev/build or transitive tooling findings; update in a reviewed maintenance slice. Account for platform-specific prerequisites and source-map processing before assigning runtime severity. |

Advisory pages were checked in the Browser tab on October 28. No exploit payloads, forced dependency changes, lockfile mutations, or paid reviews were run. Acceptance: targeted version changes pass clean-install/build/tests and UTF-8 wire tests; inspect bundled dependencies; record remaining advisories with reachable-path rationale. Avoid a blanket `npm audit fix --force`.

### F7 — Job lifecycle policy is spread across callers

`packages/core/src/client.ts:46` constructs the SDK without a request timeout/cancellation policy. Installed SDK `dist/index.mjs:2177` creates its axios instance without a timeout and its default at line 1175 is `0`. Panel `server.ts:625–627` awaits work without a request-wide AbortController, disconnect cancellation or admission limit. UI `src/api.ts:35` likewise fetches without a signal/deadline. The per-client LLM queue (`llm-client.ts:224,273`) is unbounded, and every pipeline builds its own client (`pipeline.ts:163`), so its concurrency setting is not a process-wide job budget.

Positive controls exist: image availability probes have a 5-second default and four workers; LLM attempts have 120-second timeouts, bounded attempts and capped Retry-After; rendered scanning has a 120-second caller timeout and the worker rejects overlap with 429. These do not establish a single overall job budget. The browser worker's DNS lookups and launch/context creation occur before its 110-second timer and try/finally (`browser-scanner/server.mjs:17–35`), leaving startup cleanup/deadline gaps. This last scenario was source-inspected, not fault-injected.

**Acceptance:** bounded admission/queue, overall deadline, abort propagation and cleanup on disconnect; no retry of uncertain writes; read-only retries limited to classified transient errors; retry wait consumes the job budget; test stalled SDK/fetch, overload, cancellation and scanner startup failures with synthetic adapters. Actual sustained-load memory/throughput and live dependency latency remain unmeasured.

## Baseline checks and measurements

Host: Apple M2 Max, macOS 26.6.2, arm64; Node **24.12.0**, npm **11.6.2**. CI specifies Ubuntu/Node 22. During the original audit, existing installed dependencies were used; no `npm ci` was rerun in the working checkout, no container was built, and Node 22 was not available at the checked Homebrew installation. Therefore this is a meaningful local baseline, not a reproduction of clean Linux CI.

| Command/check | Actual result | Wall time / limit |
|---|---|---|
| `/usr/bin/time -p npm run build` | Pass; core/CLI TypeScript and panel Vite build | 3.34 s; panel asset 158.06 kB / gzip 50.58 kB |
| `/usr/bin/time -p npm test` | Pass: 36 core files, 191 tests; 1 panel loopback test | 2.69 s; raw `workspace-tests.log` |
| `./node_modules/.bin/tsc -p packages/conductor-panel/tsconfig.json --noEmit` | Pass, empty output | Not separately timed; `panel-typecheck.log` |
| `/usr/bin/time -p node --test browser-scanner/*.test.mjs` | 1 pass, 2 skipped | 0.53 s; defaults do not execute native browser regressions |
| `RUN_BROWSER_TESTS=1 /usr/bin/time -p node --test browser-scanner/*.test.mjs` | 1 pass, 2 environment failures | 0.29 s; no browser assertion verdict |
| `npm audit --json` / `--omit=dev --json` | Findings as F6 | Audit commands return nonzero for findings; JSON retained |
| `npm audit --prefix browser-scanner --json` | Zero findings | Separate lockfile |
| Actual local HTTP, sanitized env, port 18762 | Health disabled 200; built panel 200; fixture list 200; heading pipeline 200; CXone apply disabled 503; fixture traversal refused 500 | Local pipeline 84.02 ms round trip, 82 ms reported; app stopped |
| Offline synthetic probes | Confirm F1–F5 and post-success audit error | Results and reproduction programs retained |
| `git diff --check` | Pass | No tracked diff |

Native browser failure in both failing tests (host-specific cache prefix replaced with `<Playwright cache>`):

```text
browserType.launch: Executable doesn't exist at <Playwright cache>/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

Full failures and stacks remain in the local-only `browser-native-tests.log`. No browser download or container startup was attempted; report this as an environment blocker, not a regression. The test's temporary local HTTP listener was closed by its finally block.

The actual product smoke used no `.env` file (absence checked), inherited only PATH, bound `127.0.0.1:18762`, explicitly disabled CXone, used `heading-order.html` and `maxLlm:0`, and stopped its own process afterward. It returned 1 finding before / 0 after, 4 byte-preserving splices, zero LLM calls and no strategy errors. `local-http-results.json` retains responses; failed local-run fields were summarized as null by the recording script, so only its HTTP 500 is recorded, not an error-body assertion. The traversal request was safely refused but has incorrect client-error classification. Local tests may open ephemeral loopback fixture listeners; none contacted live systems.

### Synthetic performance baseline

`benchmark.mjs`: one warmup and five sequential samples for each mode/size, committed-source-built code, synthetic paragraph HTML, no images, no CXone, no inference, cache disabled, network refused. Values are medians (maximum sample in parentheses), milliseconds; raw samples in `benchmark-results.json`.

| Synthetic fixture | Deterministic scan | Scan with axe | Local pipeline, default axe, max LLM 0 |
|---|---:|---:|---:|
| 10 paragraphs / 404 B | 3.03 (4.06) | 10.39 (14.62) | 19.75 (22.51) |
| 100 paragraphs / 4,004 B | 3.72 (4.16) | 21.93 (24.66) | 40.98 (41.34) |
| 500 paragraphs / 20,404 B | 9.05 (11.77) | 75.22 (89.41) | 153.81 (155.51) |

Interpretation: DOM/axe work dominates this small offline workload; the pipeline intentionally scans before and after. These data do **not** justify a broad worker-pool/cache rewrite. Fix scan correctness first, then measure realistic large pages and bounded concurrent jobs. Not measured: 5 MB limit behavior, memory retention, production percentiles, DNS/image/provider latency, Linux browser startup or real workloads. Unclosed JSDOM windows (`scan.ts:69`, `scan-axe.ts:83`, `strategies/runner.ts:47`) warrant a retained-resource experiment; a leak is not proven here.

## Architecture candidates for Chief selection

| Candidate | Strength | Deletion test and benefit | Real adapters / test surface |
|---|---|---|---|
| Deepen guarded revision module across preview/apply/restore | Strong, first | Deleting current session/write coordination would redistribute review/target/retry knowledge across routes. Concentrate it for locality; one reviewed operation gives leverage to panel and Conductor callers. | SDK and fake SDK; disk and synthetic snapshot storage. Tests and callers cross the same conceptual seam. No method interface selected. |
| Deepen guarded image-fetch module | Strong | A predicate alone is shallow relative to the policy callers must know. Absorb redirects, resolved destinations, time and byte budgets into the fetch implementation. | Native and deterministic fake fetch; exercise complete fetch policy through one seam. |
| Deepen scan execution module | Strong | Moving concurrency/error/resource rules into callers duplicates knowledge. Keep them in the execution implementation, increasing locality for local/page/pipeline scans. | Actual axe execution plus fault-injected execution; preserve genuine fixture-based assertions. |
| Deepen snapshot storage module by snapshot kind | Strong, small recovery slice | Current callers know filename conventions and metadata shapes. Centralize those facts and validate pairs before exposing recoverable entries. | Disk and temporary-disk fixtures are already used. Do not create a speculative generic storage framework. |

No candidate conflicts with [ADR-0001](../adr/0001-loopback-reviewer-attribution.md). Preserve separate `operator` and unverified `requestedBy`; CORS remains insufficient to authenticate callers. **Reuse [LT-1](https://linear.app/johnnyrobot/issue/LT-1/require-signed-reviewer-assertions-before-any-non-loopback-bridge)** for signed reviewer assertions and coordinated off-host policy, rather than filing a duplicate. Search of the bridge label returned LT-1 and LT-99; broader LT Remedy search found the other three audit tickets but no existing equivalent implementation issues.

Proposed follow-up ticket scopes, **not filed**: (1) F1/F2 guarded target + reviewed-write correctness; (2) F3 bounded image-fetch policy; (3) F4 explicit scan execution/parallel safety; (4) F5 typed recovery selection; (5) F6 targeted dependency refresh; (6) F7 job lifecycle. Each would use LT / Remedy and Conductor / `libretexts-remedy-bridge` / one triage label, with the acceptance criteria above. Chief may split correctness fixes from later module consolidation.

Subsequent skill route: use **diagnosing-bugs** on the reproduced failure selected by Chief, **tdd** for the smallest behavior slice, and **codebase-design** only where the change needs a better seam. For a multi-session chosen slice, read **to-spec** and **to-tickets** before planning it. Later code/runbook PRs require the shared Matt review + fresh Correctness gate, then the single CodeRabbit/fallback process; no paid reviewer was invoked during this audit. Recommend a focused TestSprite verification after an authorized, reachable product target exists. This is not a recommendation to mechanically run every skill.

## TestSprite: historical preflight, proposed scope, blockers

At audit time, CLI **0.15.0** was authenticated as johnnyrobot's Starter workspace, V3 and `run:tunnel` scope available. `testsprite project list --output json` returned **5 projects and `nextToken:null`**: Canvas LMS test site, Question Studio, two GrantEngine entries, and Course Workbench. **No bridge project existed at audit time**, hence there were no bridge tests/environments to inspect, no test/run IDs, no run-specific steps/artifacts and no bridge dashboard URL. Unrelated projects were not selected as substitutes.

`testsprite test list --output json` without a project returned exit 5, verbatim:

```text
Flag `--project` is invalid: is required; pass --project <id> or set TESTSPRITE_PROJECT_ID.
```

Usage before/after: **491.8 → 491.8 credits**, delta **0**; reported run price **0.5 credit**. No plan generation, project/test/environment creation, full suite, run, retry, tunnel, or upgrade occurred. Consequently there is **no TestSprite terminal pass/fail verdict**. This audit's completion is the evidenced-blocker/plans branch of the brief, not completed product verification.

Two authored plans remain in the local-only `testsprite-plans.json`: exact actual Local Lab flows for heading repair and decorative-image alt cleanup. Their transformations were checked locally against real core behavior (`local-http-results.json`, `decorative-plan-check.json`). Each individual plan was also passed to `testsprite test create --plan-from <file> --dry-run --output json`; the CLI accepted the arguments and printed a sample `test_dryrun_create_2026` response. These dry-run IDs are not real tests, no saved plan was created, and no server-side plan/assertion validation occurred. The sample responses are retained separately; `testsprite-preflight-summary.json` records the final balance and real absence of test/run IDs. They assert changed source, preserved text and zero inference, rather than only element visibility; the heading plan also checks three-pane geometry. The decorative fixture's image bytes are absent: it is intentionally source verification, not a claim of successful image rendering. Plans use Source views so they do not depend on iframe automation.

**Proposed verification target:** the actual built bridge panel, CXone disabled, no real keys or LLM calls, committed local fixtures, Bare mode and a desktop viewport. The original audit exercised this product locally; future TestSprite exposure is still blocked by the trust restriction below. This archive contains no setup or execution runbook.

**Current hard blocker:** ADR-0001 explicitly forbids this bridge behind a tunnel/reverse proxy/off-host forwarding. TestSprite's `--local` is a frontend tunnel; backend `--local` is unsupported. A port-only local project does not make cloud execution local. Do not expose this all-routes process, including with disabled integration, by inventing a waiver or relying on CORS. LT-1's signed-assertion work and an approved exposure/deployment policy are prerequisites for tunneling the bridge. An isolated local-only regression runner can cover these behaviors in the meantime but would not be TestSprite product verification.

**Proposed purchase scope only, unapproved and unimplemented:** a dedicated frontend bridge project and exactly the two authored tests above, after the required trust work and Chief approval. At the audit-time reported price, two first runs would cost approximately **1 credit**; one plan-correction retry would add **0.5** (maximum proposed run spend **1.5**, below the audit's 20-credit ceiling). Project/test creation charges, if any, were not independently priced. These historical estimates are not current pricing or spending authorization. No generation charge was proposed.

Any future verification must report real test/run IDs, assertion quality, exact-run artifacts, terminal verdicts and credit delta; dry-run samples do not satisfy those requirements.

## Cross-repo dependencies and remaining uncertainty

LT-1 requires verified reviewer signing in Conductor, unchanged forwarding in Remedy Server, verification here, and Johnny's signing-key/rollout decision. Remedy Server/Conductor callers also need coordinated handling if tokenless apply is retired or error/outcome contracts change; their code was not modified or independently audited here. A safe external conditional edit depends on CXone's actual revision semantics and must be researched/validated using an authorized synthetic/local protocol fixture before making guarantees.

At the audited SHA, CI ran only `npm ci`, root build and workspace tests (`.github/workflows/ci.yml:17`); it does not run browser-scanner's separate dependency/test suite or explicit panel typecheck. Panel's build is Vite-only (`packages/conductor-panel/package.json:13`); the extra typecheck passed manually. No lint script exists. Root build compiles core twice; this is minor build waste within a 3.34-second baseline, not a priority performance project. During the original audit, Docker/stack startup and remote CI were not exercised; the image retains the intentional loopback-only policy, which must not be loosened to make container networking convenient.

Additional source-inspected concerns for follow-up, not elevated to proven critical findings: preview maps hold full before/after HTML without a count/byte cap and prune opportunistically (`server.ts:79–102,798`); invalid request JSON/fields and fixture traversal return generic 500 instead of 4xx (`server.ts:628–637,650`); Local Lab iframes enable both scripts and same-origin (`ThreePaneViewer.tsx:48,77`), so they must not be treated as isolation for untrusted fixture/script content; no browser exploit or private content was used. Clarify fixture trust before changing that behavior. No UI visual/keyboard/screen-reader verdict was obtained.

A separate HTML preview and its location record remain local-only and are excluded from this Markdown archive. It was delivered inline in chat and opened successfully in the Browser tab; the observed document contained all four candidate headings and the evidence table. Static HTML checks passed (4 cards, 7 resolved anchor links, 16,668 bytes; both copies identical). The follow-up layout-evaluation/screenshot call did not return before it was stopped, so no screenshot or wide/narrow/light/dark visual verdict is claimed. It includes before/after diagrams and return flows; no app/browser was shell-opened and the HTML preview was not publicly published. All baseline claims and source locations refer to the audited SHA, not a proposed refactor.
