import { useState } from 'react';
import { api, type PreviewResponse, type ScanResponse } from '../api.js';
import { FindingsList } from '../components/FindingsList.js';
import { DiffView } from '../components/DiffView.js';
import { WcagReviewPanel } from '../components/WcagReviewPanel.js';

type Tier = 1 | 2 | 3;

export function ProductionTab() {
  const [pageInput, setPageInput] = useState('');
  const [tier, setTier] = useState<Tier>(1);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState<null | 'scan' | 'preview' | 'apply'>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onScan() {
    if (!pageInput) return;
    setBusy('scan'); setError(null); setPreview(null); setApplyResult(null);
    try {
      setScan(await api.scan(pageInput));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onPreview() {
    if (!pageInput) return;
    setBusy('preview'); setError(null); setApplyResult(null); setPreview(null);
    try {
      setPreview(await api.preview(pageInput, tier));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onApply() {
    if (!preview) return;
    if (!confirm(`Apply to ${preview.pagePath} on ${preview.hostname}? This writes a CXone revision.`)) return;
    setBusy('apply'); setError(null); setPreview(null); setScan(null);
    try {
      const r = await api.apply(pageInput, tier, preview);
      setApplyResult(r.applied ? `Written. ${r.audit_recorded === false ? 'Audit recording failed; preserve the snapshot and reconcile the audit before further work. ' : ''}${r.revisionSummary ?? ''}${r.snapshotPath ? ` Snapshot: ${r.snapshotPath}` : ''}${r.cxone_revision_id !== undefined ? ` CXone revision: ${r.cxone_revision_id}` : ''}` : r.applyError ?? 'No write (noise-only or empty delta).');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="card">
        <div className="row">
          <input
            type="text"
            placeholder="https://dev.libretexts.org/Sandboxes/... or page id"
            value={pageInput}
            disabled={busy !== null}
            onChange={(e) => { setPageInput(e.target.value); setPreview(null); setScan(null); setApplyResult(null); }}
          />
          <select value={tier} disabled={busy !== null} onChange={(e) => { setTier(Number(e.target.value) as Tier); setPreview(null); setApplyResult(null); }}>
            <option value={1}>Tier 1 · cheap</option>
            <option value={2}>Tier 2 · strong</option>
            <option value={3}>Tier 3 · agent</option>
          </select>
          <button onClick={onScan}    disabled={!pageInput || busy !== null}>Scan</button>
          <button onClick={onPreview} disabled={!pageInput || busy !== null}>Preview fix</button>
        </div>
        {error && <div className="status-error mono">✖ {error}</div>}
        {busy && <div className="muted">running: {busy}…</div>}
      </div>

      {scan && !preview && (
        <div className="card">
          <h2>Accessibility review</h2>
          <WcagReviewPanel
            page={scan.page}
            review={scan.wcagReview}
            exceptions={scan.dojExceptions}
          />
          <div className="muted" style={{ marginBottom: 8 }}>
            <span className="status-error">{scan.stats.bySeverity.error} errors</span>
            {' · '}
            <span className="status-warn">{scan.stats.bySeverity.warning} warnings</span>
            {' · '}
            {scan.stats.bySeverity.info} info
          </div>
          <details>
            <summary style={{ cursor: 'pointer' }}>scanner findings driving fixes</summary>
            <FindingsList findings={scan.findings} />
          </details>
        </div>
      )}

      {preview && (
        <>
          <div className="card">
            <h2>Preview · {preview.pagePath}</h2>
            <table style={{ fontSize: 13 }}>
              <tbody>
                {preview.tiersRun.map((t) => (
                  <tr key={t.tier}>
                    <td>Tier {t.tier}</td>
                    <td className="status-warn">{t.before}</td>
                    <td>→</td>
                    <td className="status-ok">{t.after}</td>
                    <td className="muted">({t.elapsedMs}ms)</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 8 }}>
              Final findings: <b>{preview.finalFindingsCount}</b>
              {preview.noiseOnlyChange && (
                <span className="status-warn"> · only serializer noise in diff — apply will be refused</span>
              )}
            </div>
          </div>
          <div className="card">
            <h2>Diff</h2>
            <DiffView diff={preview.diff} />
          </div>
          <div className="row">
            <button
              className="primary"
              onClick={onApply}
              disabled={busy !== null || preview.noiseOnlyChange || preview.beforeHtml === preview.finalHtml}
            >
              Apply (write revision)
            </button>
            <span className="muted">
              Pre-write snapshot is saved automatically; <code>remedy revert</code> restores.
            </span>
          </div>
        </>
      )}
      {applyResult && <div className="card status-ok mono">{applyResult}</div>}
    </>
  );
}
