# LibreTexts Remedy

Accessibility remediation assistant for LibreTexts CXone Expert pages.
Scans pages for WCAG 2.1 AA issues, previews AI-assisted fixes, and writes
approved revisions through guarded CXone APIs.

## Packages

- **`@libretexts/remedy-core`** — pluggable rule engine + CXone I/O. Framework-agnostic.
- **`@libretexts/remedy-cli`** — MVP demo target. `remedy scan <url>` / `remedy scan-file <html>`.
- **`@libretexts/remedy-conductor-panel`** — local staff UI and Node bridge for Conductor/Remedy Server integration.

## Where this sits in the stack

This repository is one of three that make up Remedy:

| Repository | Role |
|---|---|
| `libretexts-remedy-server` | the engine — all checking and remediation behind `/v1/*` |
| **`libretexts-remedy-bridge`** | this repo — CXone Expert page I/O and guarded writes |
| `adapt-a11y-scanner` | headless ADAPT question rendering (not needed for CXone pages) |

**To deploy them together, follow `deploy/stack/README.md` in the
`libretexts-remedy-server` repository** — that is the only compose file that
wires the full stack. The quick start below runs this bridge on its own, which
is enough for local development and for scanning a single page.

> Older names for this repository appear in commit history and in a few code
> comments: `libretexts_remedy` and `libre-remedy`. `libretexts_remedy` is also
> the name of the shared Docker network, which is an unrelated collision.

## Quick start

```bash
npm install
npm run build

# Scan a local HTML file — no credentials required
node packages/cli/dist/index.js scan-file fixtures/chap01-like.html

# Show which environment is configured (tokens masked)
node packages/cli/dist/index.js env
```

To scan a live page, copy `.env.example` to `.env` and fill in the
CXone Expert service-account credentials:

```bash
cp .env.example .env
# edit .env
node packages/cli/dist/index.js scan https://dev.libretexts.org/Sandboxes/johnnyphung/chem51/01%3A_Chapter_Notes/Chap_01
```

## Safeguards (baked in)

Every write has two independent rollback channels:

1. **On-disk snapshot** (our own, kept forever) — before every `--apply`, the entire
   before-HTML plus a metadata JSON is written to
   `.remedy/snapshots/{pageId}/{timestamp}_{hash}.{html,json}`.
   `remedy revert <page>` reads the newest valid HTML pair matching the canonical target (or a specific one pinned by `--snapshot <ts>`)
   and writes it back as a new CXone revision. The revert itself **also** saves a
   pre-revert snapshot so the rollback is itself reversible.
2. **CXone revision history** (platform-native) — every write creates a new revision on
   dev.libretexts.org that an admin can restore from the page's revision panel. The CXone
   revision id is captured in the audit log when the API returns it.

Other safeguards:

- **Dry-run is the default.** `fix` and `pipeline` require `--apply` + per-page y/N to write.
- **Owner-only boundary.** CXone is disabled unless `CXONE_INTEGRATION_ENABLED=true`. Enabled writes require host `dev.libretexts.org` and path `Sandboxes/johnnyphung` (or a descendant); a broader `REMEDY_WRITE_ALLOWLIST` is rejected as misconfiguration before any HTTP write.
- **Token masking.** `remedy env` never prints raw secrets.
- **Audit log** at `.remedy/audit.log` records every apply with before/after hashes, snapshot path, CXone revision id, operator, and ISO timestamp.
- **Secrets in `.env` only.** `.env` is git-ignored; `.env.example` is the template.

### Reverting a write

```bash
# See what we have on disk
node packages/cli/dist/index.js snapshots <page-url-or-id>

# Preview the revert — shows the diff, writes nothing
node packages/cli/dist/index.js revert <page-url-or-id> --dry-run

# Restore (prompts y/N; saves a pre-revert safety snapshot)
node packages/cli/dist/index.js revert <page-url-or-id>

# Pin a specific snapshot
node packages/cli/dist/index.js revert <page-url-or-id> --snapshot 2026-04-20T02:29:35.303Z
```

## MVP rules implemented

| Rule | WCAG SC | Detects |
|---|---|---|
| `img-alt` | 1.1.1 | `<img>` missing alt, or alt that looks like a filename/URL |
| `heading-order` | 1.3.1 | Skipped heading levels; empty headings |
| `heading-as-bold` | 1.3.1 | `<p>` containing only `<strong>`/`<b>` (misused heading) |
| `link-text-descriptive` | 2.4.4 | Bare URLs, "click here", empty link text |
| `table-header` | 1.3.1 | Data tables missing `<th>` |
| `duplicate-id` | 4.1.1 | Repeated element ids |

## Fix (preview / apply)

```bash
# Dry-run (default): writes diff + fixed.html + findings.json under ./out/
node packages/cli/dist/index.js fix "https://dev.libretexts.org/Sandboxes/johnnyphung/chem51/01%3A_Chapter_Notes/Chap_01"

# Limit to specific rules
node packages/cli/dist/index.js fix <url> --only img-alt,heading-as-bold

# Apply (opt-in, per-page y/N; refuses non-Sandboxes/ paths by default)
node packages/cli/dist/index.js fix <url> --apply --message "remediation pass 1"
```

Fixer capabilities:

| Rule | Fix behavior |
|---|---|
| `img-alt` | Calls Gemini vision to generate concise alt text (≤150 chars, WCAG-appropriate). |
| `heading-as-bold` | Promotes `<p><strong>X</strong></p>` to `<h3>`/`<h4>` based on nearest preceding heading level. |
| `link-text-descriptive` | Bare-URL case only — rewrites to `<last-path-seg> (hostname)`. Generic phrases left for human. |
| `table-header` | First row `<td>` → `<th scope="col">`, preserving attributes and children. |
| `duplicate-id` | Keeps first occurrence; suffixes later ones (`foo`, `foo-2`, `foo-3`). |
| `heading-order` | Flag-only (manual review required to restructure a document). |

## Pipeline

```
fetch page → deterministic rules → axe-core → math detection
                           │
                           ▼
                      merged findings
                           │
                           ▼
         LLM strategy layer (Tier 1 default)
           heads → images → links → tables → figures → math → contrast
                           │
                           ▼
                      re-scan gate
                           │
                           ▼
                 diff + fixed.html + report
                           │
                           ▼
                  apply (human-gated)
```

### LLM providers (pick one)

Switch via `REMEDY_LLM_PROVIDER` in `.env`:

| Provider | Notes |
|---|---|
| `openrouter` | Free-tier models available. `OPENROUTER_API_KEY`. |
| `ollama-cloud` | Subscription. `OLLAMA_API_KEY`. |
| `ollama-local` | Local Ollama server. No key. |
| `gemini-compat` | Google's OpenAI-compat endpoint. `GEMINI_API_KEY`. |
| `custom` | Any OpenAI-compatible endpoint via `REMEDY_LLM_BASE_URL`. |

All providers speak the same `/chat/completions` payload shape, so rules/strategies don't care which one is active.

## Status

- [x] Core library + CLI scan path (offline + live, verified on page 3971).
- [x] Deterministic rule engine (11 rules: img-alt, heading-order, heading-as-bold, link-text, table-header, duplicate-id, math-accessible, chart-alt, figure-wrap, table-structure, form-label).
- [x] Per-rule fixers + dry-run diff + LLM-powered alt text.
- [x] Tiered remediation pipeline inspired by `project-remedy-server`.
- [x] OpenAI-compatible LLM provider abstraction (OpenRouter / Ollama Cloud / Ollama local / Gemini-compat).
- [x] `axe-core` integration (jsdom-compatible ruleset).
- [x] Math rule (MathJax / MathML detection + LaTeX-to-spoken-form describer).
- [x] Strategy runner (`RemediationStrategyRunner` port; headings / images / links / contrast).
- [x] Tier-1/Tier-2 escalation + re-scan gate (`runPipeline`).
- [x] Tier-3 agent loop (inspect / apply_rule_fix / set_attribute / finish).
- [x] Chart-to-accessible-HTML reconstruction (vision → alt + long description + `<table>` data equivalent).
- [x] Table remediation (LLM-assisted scope + caption + thead/tbody + header ids).
- [x] Form-label inference.
- [x] **Snapshots + revert command** — full rollback for any live write.
- [x] **CXone revision id capture** in audit log (platform-native recovery).
- [ ] First live write to `Sandboxes/johnnyphung/remedy-test` (copy Chap_01 there first).
- [ ] Review jsdom serializer behaviour (`<br />` → `<br>`, entity normalization) before writing production textbooks.
- [x] Local Conductor bridge API for scan, preview, and apply.

## Local Conductor Bridge

The Conductor panel package exposes local CXone routes used by the Python
Remedy Server proxy:

```text
POST /v1/cxone/page/scan
POST /v1/cxone/page/preview-fix
POST /v1/cxone/page/apply-fix
```

Run it from the repo root:

```bash
npm run dev:api --workspace @libretexts/remedy-conductor-panel
```

The bridge listens on `http://127.0.0.1:5175` by default and consumes the root
`.env` credentials. `GET /healthz` reports sanitized process liveness only.
Production mutation is currently unavailable pending proven atomic CXone conditional edits;
`/readyz` reports `mutate:false` and signed writes return 503 `conditional_write_unproven`.
See [the conditional-edit gate and later sandbox procedure](docs/release/cxone-conditional-edit-gate.md).
The signed profile uses authenticated `GET /readyz` capability checks; see
[the signed writer integration contract](docs/release/lt-1-signed-writer.md).

Guarded apply now requires the single-use token returned with the reviewed
preview. See [the local write integration and recovery contract](docs/release/lt-116-reviewed-writes.md)
for caller migration, success/unknown outcomes and remaining release limits.
