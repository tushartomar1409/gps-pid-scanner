import { useState } from 'react';
import { Modal } from '../../components/Modal.jsx';
import { Button } from '../../components/Button.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { toOptions } from '../../hooks/useLookups.js';
import { assignmentsApi } from '../../api/resources.js';
import { parseApiError } from '../../utils/apiErrors.js';
import { addDaysISO } from '../../utils/dates.js';

const RESULT_STYLE = { created: 'text-emerald-700', skipped_duplicate: 'text-slate-600', error: 'text-red-700' };

export function CopyDayModal({ lookups, defaultTarget, onClose, onDone }) {
  const [from, setFrom] = useState(addDaysISO(defaultTarget, -1));
  const [to, setTo] = useState(defaultTarget);
  const [zoneId, setZoneId] = useState('');
  const [wardId, setWardId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const routeName = (id) => (lookups.routes || []).find((r) => r.id === id)?.code ?? `#${id}`;
  const vehicleName = (id) => (lookups.vehicles || []).find((v) => v.id === id)?.name ?? `#${id}`;

  const run = async () => {
    if (!from || !to || from === to) return setError('Choose two different dates');
    setBusy(true);
    setError('');
    try {
      const { data } = await assignmentsApi.bulk({
        copy_from_date: from, to_date: to,
        ...(zoneId ? { zone_id: Number(zoneId) } : {}), ...(wardId ? { ward_id: Number(wardId) } : {}),
      });
      setResult(data);
      onDone?.();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title="Copy assignments from another day"
      onClose={busy ? undefined : onClose}
      footer={result ? <Button onClick={onClose}>Close</Button> : (
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={run} loading={busy}>Copy assignments</Button>
        </>
      )}
    >
      {!result ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Copy from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="Copy to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Select label="Zone (optional)" placeholder="All zones" value={zoneId} options={toOptions(lookups.zones)} onChange={(e) => { setZoneId(e.target.value); setWardId(''); }} />
          <Select label="Ward (optional)" placeholder="All wards" value={wardId} options={toOptions((lookups.wards || []).filter((w) => !zoneId || String(w.zone_id) === zoneId))} onChange={(e) => setWardId(e.target.value)} />
          <p className="text-xs text-slate-500 sm:col-span-2">
            Cancelled assignments are not copied. Shift windows move by the same number of days. Each copy takes a fresh PID snapshot from the current route.
          </p>
          {error && <p className="text-sm text-red-700 sm:col-span-2" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-700" role="status">
            {result.summary.total} assignment(s) processed: <strong className="text-emerald-700">{result.summary.created} created</strong>,{' '}
            {result.summary.skipped_duplicate} already existed, <strong className={result.summary.error ? 'text-red-700' : ''}>{result.summary.error} failed</strong>.
          </p>
          <DataTable
            rowKey="index"
            rows={result.results}
            columns={[
              { key: 'route_id', header: 'Route', render: (r) => routeName(r.route_id) },
              { key: 'vehicle_id', header: 'Vehicle', render: (r) => vehicleName(r.vehicle_id) },
              { key: 'result', header: 'Result', render: (r) => <span className={`font-medium ${RESULT_STYLE[r.result]}`}>{r.result.replace('_', ' ')}</span> },
              { key: 'message', header: 'Details', render: (r) => <span className="whitespace-normal text-xs">{r.message || '—'}</span> },
            ]}
            emptyTitle="Nothing to copy"
            emptyMessage="The source date has no (non-cancelled) assignments matching the filters."
          />
        </div>
      )}
    </Modal>
  );
}
