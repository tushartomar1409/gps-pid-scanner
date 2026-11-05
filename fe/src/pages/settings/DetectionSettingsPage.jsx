// Visit Detection Settings (SUPER_ADMIN, GUIDE #9 F1). Per-key validation + save; reprocess section.
import { useEffect, useState } from 'react';
import { detectionApi, settingsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { usePermittedLookups } from '../../components/MonitoringFilters.jsx';
import { useToast } from '../../components/Toast.jsx';
import { Button } from '../../components/Button.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { PageSkeleton } from '../../components/Skeleton.jsx';
import { toOptions } from '../../hooks/useLookups.js';
import { todayIST } from '../../utils/dates.js';
import { apiErrorMessage } from '../../utils/apiErrors.js';
import { RECOMMENDED_START, fieldKind, groupDetectionSettings, isNullable, parseSettingInput, rangeText, toInputString } from './settingsLogic.js';

export function SettingField({ row, onSaved }) {
  const toast = useToast();
  const kind = fieldKind(row.schema || {});
  const [raw, setRaw] = useState(kind === 'boolean' ? Boolean(row.setting_value) : toInputString(row.setting_value));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setRaw(kind === 'boolean' ? Boolean(row.setting_value) : toInputString(row.setting_value));
  }, [row.setting_value, kind]);

  const dirty = kind === 'boolean' ? raw !== Boolean(row.setting_value) : raw !== toInputString(row.setting_value);
  const label = row.setting_key.replace(/^detection\./, '');

  const save = async () => {
    const parsed = parseSettingInput(row.schema || {}, raw);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const { data } = await settingsApi.update(row.setting_key, parsed.value);
      toast.success(`${label} saved. Applies to new processing only.`);
      onSaved(data);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  const hint = [rangeText(row.schema || {}), row.default !== null && row.default !== undefined ? `default ${String(row.default)}` : isNullable(row.schema || {}) ? 'default off' : '']
    .filter(Boolean).join(' · ');

  return (
    <div className="grid grid-cols-1 items-start gap-2 border-b border-slate-100 py-3 last:border-0 md:grid-cols-[1fr_16rem_auto]">
      <div>
        <p className="font-mono text-sm font-medium text-slate-800">{label}</p>
        {row.description && <p className="text-xs text-slate-500">{row.description}</p>}
      </div>
      <div>
        {kind === 'boolean' ? (
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} aria-label={label} />
            {raw ? 'On' : 'Off'}
          </label>
        ) : kind === 'enum' ? (
          <Select aria-label={label} value={raw} options={row.schema.enum.map((v) => ({ value: v, label: v }))} onChange={(e) => setRaw(e.target.value)} error={error} hint={hint} />
        ) : (
          <Input aria-label={label} inputMode="decimal" value={raw} onChange={(e) => { setRaw(e.target.value); setError(null); }} error={error} hint={hint} />
        )}
        {kind === 'boolean' && error && <p className="text-xs text-red-600" role="alert">{error}</p>}
      </div>
      <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={saving} onClick={save}>Save</Button>
    </div>
  );
}

export function ReprocessSection() {
  const toast = useToast();
  const lookups = usePermittedLookups(['zones']);
  const [mode, setMode] = useState('date');
  const [date, setDate] = useState(todayIST());
  const [zone, setZone] = useState('');
  const [raId, setRaId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const body = mode === 'date' ? { operational_date: date, ...(zone ? { zone_id: Number(zone) } : {}) } : { route_assignment_id: Number(raId) };
  const valid = mode === 'date' ? Boolean(date) : Number.isInteger(Number(raId)) && Number(raId) > 0;
  const scopeText = mode === 'date' ? `all assignments on ${date}${zone ? ' in the selected zone' : ''}` : `assignment #${raId}`;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data, message } = await detectionApi.reprocess(body);
      setResult({ data, message });
      toast.success('Reprocessing queued');
    } catch (err) {
      setError(apiErrorMessage(err, 'Reprocess failed'));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Reprocess">
      <h2 className="text-sm font-semibold text-slate-800">Reprocess past data</h2>
      <p className="mb-3 text-xs text-slate-500">Re-evaluate raw GPS with the current settings. Use after changing settings for days already processed.</p>
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Scope" value={mode} options={[{ value: 'date', label: 'By date (optional zone)' }, { value: 'assignment', label: 'By assignment id' }]} onChange={(e) => setMode(e.target.value)} />
        {mode === 'date' ? (
          <>
            <Input label="Date" type="date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} />
            <Select label="Zone" placeholder="All zones" value={zone} options={toOptions(lookups.zones)} onChange={(e) => setZone(e.target.value)} />
          </>
        ) : (
          <Input label="Assignment id" inputMode="numeric" value={raId} onChange={(e) => setRaId(e.target.value.replace(/\D/g, ''))} />
        )}
        <Button variant="danger" disabled={!valid} onClick={() => setConfirm(true)}>Reprocess…</Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
      {result && (
        <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs" role="status">
          <p className="font-medium text-slate-800">{result.message}</p>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-slate-700">{JSON.stringify(result.data, null, 2)}</pre>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Reprocess GPS visit data?"
        message={`Derived visit data (visit events and PID daily statuses) for ${scopeText} will be reset and rebuilt from the stored GPS points using the current settings. Raw GPS data is kept and is not changed. Numbers on the dashboard will change while it runs.`}
        confirmLabel="Reprocess"
        busy={busy}
        onConfirm={run}
        onCancel={() => setConfirm(false)}
      />
    </section>
  );
}

export default function DetectionSettingsPage() {
  const q = useApiQuery(() => settingsApi.all().then((r) => r.data), 'settings');
  const [rows, setRows] = useState(null);
  useEffect(() => setRows(q.data), [q.data]);
  const onSaved = (row) => setRows((rs) => rs.map((r) => (r.setting_key === row.setting_key ? { ...r, ...row } : r)));

  if (q.error) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!rows) return <PageSkeleton />;
  const groups = groupDetectionSettings(rows.filter((r) => r.editable));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Visit Detection Settings</h1>
        <p className="mt-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="note">
          Changes apply to <strong>new processing only</strong>. Already-processed days keep their results until you reprocess them below.
        </p>
      </div>
      <section className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm" aria-label="Recommended field-trial starting point">
        <h2 className="mb-2 font-semibold text-sky-950">Recommended field-trial starting point</h2>
        <p className="mb-2 text-xs text-sky-900">From the detection tuning guide. For reference only: nothing here is applied automatically.</p>
        <table className="w-full text-xs">
          <tbody>
            {RECOMMENDED_START.map(([k, v, why]) => (
              <tr key={k} className="align-top">
                <td className="py-0.5 pr-3 font-mono text-sky-950">{k.replace(/^detection\./, '')}</td>
                <td className="py-0.5 pr-3 font-semibold text-sky-950">{v}</td>
                <td className="py-0.5 text-sky-900">{why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {groups.map((g) => (
        <section key={g.id} className="rounded-lg border border-slate-200 bg-white px-4 py-2 shadow-sm" aria-label={g.title}>
          <h2 className="pt-2 text-sm font-semibold text-slate-800">{g.title}</h2>
          {g.rows.map((r) => <SettingField key={r.setting_key} row={r} onSaved={onSaved} />)}
        </section>
      ))}
      <ReprocessSection />
    </div>
  );
}
