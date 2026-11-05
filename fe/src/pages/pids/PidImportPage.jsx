// 3-step PID import: Upload -> Validate (dry run) -> Commit (GUIDE #5 B). The File stays in state.
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/Button.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { useToast } from '../../components/Toast.jsx';
import { pidsApi } from '../../api/resources.js';
import { parseApiError } from '../../utils/apiErrors.js';
import { downloadBlob } from '../../utils/download.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FINDINGS_PAGE = 25;

/** Client-side pre-check: extension + size. Returns an error message or null. */
export function checkFile(file) {
  if (!file) return 'Choose a file';
  const name = file.name.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.xlsx')) return 'Only .csv and .xlsx files are accepted';
  if (file.size === 0) return 'The file is empty';
  if (file.size > MAX_FILE_BYTES) return 'File is larger than 10 MB';
  return null;
}

const STEPS = ['Upload', 'Validate', 'Commit'];

function Stepper({ step }) {
  return (
    <ol className="flex items-center gap-2 text-sm" aria-label="Import steps">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === step ? 'step' : undefined}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${i <= step ? 'bg-emerald-700 text-white' : 'bg-slate-200 text-slate-600'}`}>{i + 1}</span>
          <span className={i === step ? 'font-semibold text-slate-900' : 'text-slate-500'}>{s}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-slate-300" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function SummaryCard({ label, value, tone = 'slate' }) {
  const tones = { slate: 'text-slate-900', green: 'text-emerald-700', red: 'text-red-700', amber: 'text-amber-700' };
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tones[tone]}`}>{value ?? '—'}</p>
    </div>
  );
}

export default function PidImportPage() {
  const toast = useToast();
  const inputRef = useRef(null);
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [onExisting, setOnExisting] = useState('skip');
  const [validation, setValidation] = useState(null);
  const [serverError, setServerError] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [findingsPage, setFindingsPage] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);

  const pickFile = (f) => {
    const err = checkFile(f);
    setFileError(err || '');
    setServerError('');
    setFile(err ? null : f);
    setValidation(null);
    setResult(null);
  };

  // Validation findings depend on on_existing (e.g. ward-move / kept-coordinate checks): re-validate.
  const changeOnExisting = (v) => {
    setOnExisting(v);
    if (validation) {
      setValidation(null);
      setStep(0);
    }
  };

  const runValidate = async () => {
    setBusy(true);
    setServerError('');
    setProgress(0);
    try {
      const { data } = await pidsApi.importFile(file, { mode: 'validate', on_existing: onExisting }, setProgress);
      setValidation(data);
      setFindingsPage(1);
      setStep(1);
    } catch (err) {
      setServerError(parseApiError(err).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const runCommit = async () => {
    setBusy(true);
    setServerError('');
    try {
      const { data } = await pidsApi.importFile(file, { mode: 'commit', on_existing: onExisting }, setProgress);
      setResult(data);
      setConfirming(false);
      setStep(2);
      toast.success('Import committed');
    } catch (err) {
      setConfirming(false);
      setServerError(parseApiError(err).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const downloadReport = async () => {
    try {
      const blob = await pidsApi.importFile(file, { mode: 'validate', on_existing: onExisting, report: 'csv' });
      downloadBlob(blob, 'pid-import-report.csv');
    } catch (err) {
      toast.error(parseApiError(err).message);
    }
  };

  const downloadTemplate = async (format) => {
    try {
      downloadBlob(await pidsApi.template(format), `pid-import-template.${format}`);
    } catch (err) {
      toast.error(parseApiError(err).message);
    }
  };

  const findings = useMemo(
    () => (validation?.findings || []).filter((f) => !levelFilter || f.level === levelFilter).map((f, i) => ({ ...f, _key: i })),
    [validation, levelFilter],
  );
  const pageRows = findings.slice((findingsPage - 1) * FINDINGS_PAGE, findingsPage * FINDINGS_PAGE);
  const s = validation?.summary;
  const canCommit = Boolean(s && s.valid > 0);

  const reset = () => {
    setStep(0);
    setFile(null);
    setValidation(null);
    setResult(null);
    setServerError('');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Import PIDs</h1>
          <p className="text-sm text-slate-500">CSV or Excel. Nothing is saved until you commit.</p>
        </div>
        <Stepper step={step} />
      </div>

      {serverError && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{serverError}</p>
      )}

      {/* Step 1 — upload */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800">1. Choose file</h2>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => downloadTemplate('csv')}>Template (CSV)</Button>
            <Button variant="secondary" size="sm" onClick={() => downloadTemplate('xlsx')}>Template (XLSX)</Button>
          </div>
        </div>
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm ${dragOver ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 hover:bg-slate-50'}`}
        >
          <span className="font-medium text-slate-700">{file ? file.name : 'Drag & drop a .csv or .xlsx file, or click to browse'}</span>
          <span className="text-xs text-slate-500">
            {file ? `${(file.size / 1024).toFixed(1)} KB` : 'Columns: pid_number*, owner_name, mobile, address, zone_code*, ward_number*, latitude, longitude, route_code — max 10 MB'}
          </span>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx"
            className="sr-only"
            aria-label="Import file"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
        </label>
        {fileError && <p className="mt-2 text-sm text-red-600" role="alert">{fileError}</p>}

        <fieldset className="mt-4 flex flex-col gap-2 text-sm">
          <legend className="mb-1 font-medium text-slate-700">If a PID number already exists</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="on_existing" value="skip" checked={onExisting === 'skip'} onChange={() => changeOnExisting('skip')} className="mt-0.5" />
            <span><strong>Skip it</strong> — existing PIDs are left unchanged.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="on_existing" value="update" checked={onExisting === 'update'} onChange={() => changeOnExisting('update')} className="mt-0.5" />
            <span>
              <strong>Update it</strong> — non-empty values in the file replace stored values. Manually corrected or verified coordinates are{' '}
              <strong>never</strong> overwritten, and empty coordinate cells keep the stored point.
            </span>
          </label>
        </fieldset>

        <div className="mt-4 flex items-center gap-3">
          <Button onClick={runValidate} disabled={!file} loading={busy && step === 0}>Validate file</Button>
          {progress !== null && (
            <div className="flex flex-1 items-center gap-2" aria-label="Upload progress">
              <div className="h-2 flex-1 overflow-hidden rounded bg-slate-200">
                <div className="h-full bg-emerald-600 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span className="w-24 text-xs text-slate-500">{progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Checking rows…'}</span>
            </div>
          )}
        </div>
      </section>

      {/* Step 2 — validation results */}
      {validation && step >= 1 && (
        <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">2. Validation results</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <SummaryCard label="Total rows" value={s.total} />
            <SummaryCard label="Valid" value={s.valid} tone="green" />
            <SummaryCard label="Errors" value={s.errors} tone="red" />
            <SummaryCard label="Warnings" value={s.warnings} tone="amber" />
            <SummaryCard label="Duplicates in file" value={s.duplicates_in_file} tone={s.duplicates_in_file ? 'red' : 'slate'} />
            <SummaryCard label="Already in DB" value={s.existing_in_db} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <label htmlFor="level-filter" className="text-slate-600">Show</label>
              <select id="level-filter" value={levelFilter} onChange={(e) => { setLevelFilter(e.target.value); setFindingsPage(1); }} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
                <option value="">All findings</option>
                <option value="error">Errors</option>
                <option value="warning">Warnings</option>
              </select>
              {validation.findings_truncated && <span className="text-xs text-slate-500">First 1,000 of {s.findings_total} findings shown.</span>}
            </div>
            <Button variant="secondary" size="sm" onClick={downloadReport}>Download full report (CSV)</Button>
          </div>
          <DataTable
            rowKey="_key"
            columns={[
              { key: 'row', header: 'Row' },
              { key: 'pid_number', header: 'PID' },
              { key: 'level', header: 'Level', render: (f) => <span className={f.level === 'error' ? 'font-medium text-red-700' : 'text-amber-700'}>{f.level}</span> },
              { key: 'field', header: 'Field' },
              { key: 'message', header: 'Message', render: (f) => <span className="whitespace-normal">{f.message}</span> },
            ]}
            rows={pageRows}
            pagination={findings.length ? { page: findingsPage, limit: FINDINGS_PAGE, total: findings.length, total_pages: Math.max(1, Math.ceil(findings.length / FINDINGS_PAGE)) } : null}
            onPageChange={setFindingsPage}
            emptyTitle={levelFilter ? `No ${levelFilter}s` : 'No problems found'}
            emptyMessage="Every row passed validation."
          />
          {step === 1 && (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setConfirming(true)} disabled={!canCommit}>
                Import {s.valid} valid row{s.valid === 1 ? '' : 's'}
              </Button>
              {!canCommit && <span className="text-sm text-red-700">There are no valid rows to import. Fix the file and validate again.</span>}
              {canCommit && s.errors > 0 && <span className="text-sm text-slate-600">{s.errors} row(s) with errors will be skipped.</span>}
            </div>
          )}
        </section>
      )}

      {/* Step 3 — result */}
      {result && step === 2 && (
        <section className="flex flex-col gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4" role="status">
          <h2 className="text-sm font-semibold text-emerald-900">3. Import complete</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard label="Inserted" value={result.result.inserted} tone="green" />
            <SummaryCard label="Updated" value={result.result.updated} />
            <SummaryCard label="Skipped (existing)" value={result.result.skipped_existing} />
            <SummaryCard label="Route links added" value={result.result.route_links} />
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link to="/pids" className="font-medium text-emerald-800 hover:underline">View imported PIDs</Link>
            <Link to="/pids?has_coords=false" className="font-medium text-emerald-800 hover:underline">Fix missing coordinates</Link>
            <button type="button" onClick={reset} className="font-medium text-slate-700 hover:underline">Import another file</button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirming}
        variant="primary"
        title="Import PIDs?"
        message={`${s?.valid ?? 0} valid row(s) will be written in one transaction (${onExisting === 'skip' ? 'existing PIDs skipped' : 'existing PIDs updated'}). Rows with errors are not imported.`}
        confirmLabel="Import"
        busy={busy}
        onConfirm={runCommit}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
