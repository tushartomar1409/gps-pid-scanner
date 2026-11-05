// Map-based coordinate correction (flow.txt §5.5). Drag the marker or click the map; inputs stay in sync.
import { useEffect, useState } from 'react';
import { Marker, useMap } from 'react-leaflet';
import { Modal } from '../../components/Modal.jsx';
import { Button } from '../../components/Button.jsx';
import { Input } from '../../components/Input.jsx';
import { useToast } from '../../components/Toast.jsx';
import { BaseMap } from '../../components/map/BaseMap.jsx';
import { MapClick } from '../../components/map/MapHelpers.jsx';
import { MAP_CONFIG } from '../../config/mapConfig.js';
import { serviceAreaWarning } from '../../utils/mapStyles.js';
import { pidsApi } from '../../api/resources.js';
import { parseApiError } from '../../utils/apiErrors.js';

function Recenter({ position }) {
  const map = useMap();
  useEffect(() => {
    if (position) map.panTo(position);
  }, [position, map]);
  return null;
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '') : '');

/** Pure: parse the two inputs into a position or field errors. */
export function parseLatLng(latStr, lngStr) {
  const lat = Number(latStr);
  const lng = Number(lngStr);
  const errors = {};
  if (latStr === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) errors.latitude = 'Latitude must be between -90 and 90';
  if (lngStr === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) errors.longitude = 'Longitude must be between -180 and 180';
  return Object.keys(errors).length ? { errors } : { lat, lng };
}

export function FixLocationModal({ pid, onClose, onSaved, renderMap = true }) {
  const toast = useToast();
  const hasCoords = pid?.latitude != null;
  const [latStr, setLatStr] = useState(hasCoords ? fmt(pid.latitude) : '');
  const [lngStr, setLngStr] = useState(hasCoords ? fmt(pid.longitude) : '');
  const [verified, setVerified] = useState(false);
  const [errors, setErrors] = useState({});
  const [pendingWarning, setPendingWarning] = useState(null);
  const [saving, setSaving] = useState(false);

  const parsed = parseLatLng(latStr, lngStr);
  const position = parsed.errors ? null : [parsed.lat, parsed.lng];

  const moveTo = ({ lat, lng }) => {
    setLatStr(fmt(lat));
    setLngStr(fmt(lng));
    setErrors({});
    setPendingWarning(null);
  };

  const send = async (lat, lng) => {
    setSaving(true);
    try {
      const { data } = await pidsApi.updateCoordinates(pid.id, { latitude: lat, longitude: lng, ...(verified ? { verified: true } : {}) });
      if (data.warning) toast.info(`Saved. Server note: ${data.warning}`);
      else toast.success(`Location of ${pid.pid_number} updated`);
      onSaved?.(data);
    } catch (err) {
      const e = parseApiError(err);
      setErrors(e.fieldErrors);
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => {
    const p = parseLatLng(latStr, lngStr);
    if (p.errors) return setErrors(p.errors);
    const warning = serviceAreaWarning(p.lat, p.lng, MAP_CONFIG.serviceAreaBbox);
    if (warning && !pendingWarning) return setPendingWarning(warning); // confirm in the UI first
    send(p.lat, p.lng);
  };

  return (
    <Modal
      open
      size="lg"
      title={`Fix location — ${pid.pid_number}`}
      onClose={saving ? undefined : onClose}
      footer={
        pendingWarning ? (
          <>
            <Button variant="secondary" onClick={() => setPendingWarning(null)} disabled={saving}>Cancel</Button>
            <Button onClick={onSave} loading={saving}>Save anyway</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={onSave} loading={saving} disabled={!position}>Save location</Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-600">
          {hasCoords ? 'Drag the marker or click the map to move it.' : 'This PID has no coordinates yet. Click the map to place it.'}
          {pid.address ? <> Address: <span className="font-medium">{pid.address}</span></> : null}
        </p>
        {renderMap && (
          <BaseMap center={position || MAP_CONFIG.center} zoom={position ? 17 : MAP_CONFIG.zoom} className="h-80">
            <MapClick onClick={moveTo} />
            <Recenter position={position} />
            {position && <Marker position={position} draggable eventHandlers={{ dragend: (e) => moveTo(e.target.getLatLng()) }} />}
          </BaseMap>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Latitude" inputMode="decimal" value={latStr} onChange={(e) => { setLatStr(e.target.value); setPendingWarning(null); }} error={errors.latitude} />
          <Input label="Longitude" inputMode="decimal" value={lngStr} onChange={(e) => { setLngStr(e.target.value); setPendingWarning(null); }} error={errors.longitude} />
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Mark as verified
          </label>
        </div>
        {pendingWarning && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {pendingWarning} Check the point before saving.
          </p>
        )}
        <p className="text-xs text-slate-500">Existing daily assignment snapshots keep the old coordinates; only new assignments use the corrected point.</p>
      </div>
    </Modal>
  );
}
