# Isolated full-scan evidence (LT-123)

Every full scan creates an independent axe runtime inside its own JSDOM window.
The installed trusted axe source executes with `runScripts: outside-only`;
authored scripts and external resources do not execute. Setup, run, result
mapping and cleanup use that window. No host global is installed or overwritten,
and no axe module singleton run state is shared between concurrent scans.
The scanner closes its owned windows after success and failure, including its
deterministic scan and editor-chrome extraction windows.

`scanHtmlFull`, default `scanPage`, `fixPage` and page/local pipelines reject
with `ScanEngineError` when axe cannot produce evidence. HTTP scan and preview
return 503 `{error:"scan_engine_failed",evidence_usable:false}` with no findings
or usable preview token. They cannot silently return a deterministic-only clean
result. Fix previews now include the full scan evidence; only registered
fixable rules can mutate content. A failed pipeline rescan rejects the result.
Explicit core `axe:false` remains a deliberate deterministic-only mode; HTTP
callers cannot silently choose it. Rendered evidence does not repair a failed
source scan: the source failure prevents that combined response.

Tests use real axe/JSDOM concurrently through public full scans, compare identical
and distinct documents against serial results, and check host descriptors.
Synthetic external runtime faults cover setup and run failure, window closure,
public fix/pipeline rejection and real local HTTP responses. No external CXone,
AI or rendered-browser service is called. JSDOM evidence is not a native browser
or assembled-stack certificate. General admission/cancellation/deadlines and
cross-stack release verification remain separate LT-113/LT-111 gates.
