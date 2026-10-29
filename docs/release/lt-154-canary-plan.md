# Operator-only conditional edit canary preparation (LT-154)

Production mutation stays unavailable. The [vendor questions](lt-154-vendor-questions.md)
require a current vendor contract before LibreTexts' authorized integration/
deployment operator selects an exact disposable page.
Passing finite accepted/stale/same-timestamp trials cannot establish atomicity.
This preparation neither sends a vendor message nor clears the production hold.

Run from this repo with Bash on macOS or Linux:

```sh
bash tools/cxone-canary-wizard.sh --dry-run
```

Default/dry-run prints the stages without network, credentials, prompts or file
writes. The committed wizard uses the unchanged Matt template library. Syntax,
static analysis and default/dry-run checks are automated. ShellCheck excludes
SC1087 (the inherited template's `$e[Enter` expansion) and SC2329 (unused shared
helpers); stages themselves have no excluded finding. No interactive/operator
run was executed by an agent.

Only an explicitly authorized LibreTexts validation operator may run:

```sh
bash tools/cxone-canary-wizard.sh --operator
```

Operator mode requires terminal input; piped answers are refused before prompts
or setup. The wizard **does not issue requests**. It walks the operator through exact
manual steps and reserves/logs mutation attempts before the human performs them.
It cannot verify the truth of a human attestation or capture requests made
outside this procedure. The approved client/request syntax must come from the
current vendor contract; this plan does not invent unsupported preconditions,
HTTP status behavior, an admin console path, or an idempotency mechanism.

| Stage | Captured values/evidence | Destination |
|---|---|---|
| Current vendor contract | Absolute restricted contract file; explicit semantic confirmation | New restricted canary directory/config |
| Disposable target | Exact host `dev.libretexts.org`, numeric page ID, exact `Sandboxes/johnnyphung/…` path; existing credential **FILE path only** | Config; credential contents never read/stored |
| Baseline | Matching synthetic body/revision/precondition, hash/raw timestamp, versions, history and target confirmation | Operator saves restricted baseline evidence |
| Accepted controls | Apply A→B then restore B→A | Attempts1–2 |
| Stale controls | Independent edit; stale apply; restore; independent edit; stale restore; restore | Attempts3–8 |
| Same timestamp | One independent edit, observed timestamp comparison; stale apply/restore only for an actual collision | Attempts9–11; otherwise explicitly untested |
| Cleanup/export | Exact current known trial revision; restore initial baseline as a new revision; verify and export sanitized evidence | Attempt12 maximum, plus operator evidence summary |

Each attempt requires confirmation, local reservation and a verified
`success` or `rejection` outcome matching its expected role. Record HTTP status,
sanitized response, subsequent body/hash/revision and history. A rejection is
valid only when the current foreign/intervening revision remains untouched;
HTTP success, `conflict` text or an HTTP4xx alone cannot establish no write.
Read-only baseline/verification GETs do not spend mutation attempts. No blind
retry, collision search loop, or repeated independent edit is permitted.

Unknown/lost response, foreign edit, unexpected acceptance/rejection, changed
identity or insufficient budget stops the procedure immediately. Preserve all
evidence and leave the page for operator reconciliation. Do not attempt cleanup
after uncertainty. Never infer settlement from elapsed time, equality or key
rotation. If no identical timestamp is observed, record that case as untested
and proceed only to separately authorized safe cleanup.

The cap is **12 cumulative mutation attempts including cleanup**, reserved before
manual execution. Reserve the cleanup slot and never spend it on another trial.
The new evidence directory must not already exist. Do not rerun to reset the
count or replay/resume actions: a stopped run requires a new explicit operator
review of its preserved ledger and remaining allowance. Do not delete history,
snapshots, audit records, the disposable page, or evidence as cleanup.

LibreTexts' integration/deployment team owns vendor confirmation and arranging
explicit authorization for credentials, exact targets and live validation. None
of those actions is authorized by this preparation or requested from Johnny. Keep the credential file restricted;
never paste a password/token into the wizard, browser or chat. No keyring,
production configuration or feature flag is changed. Readiness remains
`mutate:false`; these files are candidate preparation under LT-111, not deployment
approval. The parent LT-154 remains open for vendor guarantees and authorized
execution/evidence.

The append-only `attempts.tsv` records attempt number, event (`reserved` or
`outcome`), UTC time, expected outcome, description and state. A descriptive
`pending` reservation is appended before the operator is paused to act; a
correlated outcome event is appended afterward without overwriting the original.
If interruption leaves only a reservation, preserve it as pending/uncertain and
stop for operator reconciliation. The counter alone is insufficient evidence.
The local log does not certify remote settlement or replace vendor evidence.
