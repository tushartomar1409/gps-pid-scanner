import { useCallback, useState } from 'react';
import { Popup } from 'react-leaflet';
import { BaseMap } from '../../components/map/BaseMap.jsx';
import { BoundsWatcher } from '../../components/map/MapHelpers.jsx';
import { PidPointsLayer } from '../../components/map/PidPointsLayer.jsx';
import { MapLegend } from '../../components/map/MapLegend.jsx';
import { Button } from '../../components/Button.jsx';
import { useBboxQuery } from '../../hooks/useBboxQuery.js';
import { COORD_STATUS_LEGEND, boundsToBbox } from '../../utils/mapStyles.js';

/** Map view of PIDs sharing the list's zone/ward/route filters (coordinates required; ACTIVE only). */
export function PidMapView({ params, canWrite, onFixLocation }) {
  const filters = { zone_id: params.zone_id, ward_id: params.ward_id, route_id: params.route_id };
  const { setBbox, points, truncated, count, loading, error } = useBboxQuery(filters);
  const [selected, setSelected] = useState(null);
  const onBounds = useCallback((bounds) => setBbox(boundsToBbox(bounds)), [setBbox]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span>{loading ? 'Loading points…' : `${count} PIDs in view`}</span>
        {(params.status || params.coord_status || params.has_coords || params.search) && (
          <span className="text-xs text-slate-500">Map shows active PIDs with coordinates; status / search filters apply to the table only.</span>
        )}
      </div>
      {truncated && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          Showing {count} of more points — zoom in to see all PIDs in this area.
        </p>
      )}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
      <div className="relative">
        <BaseMap className="h-[560px]">
          <BoundsWatcher onChange={onBounds} />
          <PidPointsLayer points={points} onPointClick={setSelected} />
          {selected && (
            <Popup position={[selected.latitude, selected.longitude]} eventHandlers={{ remove: () => setSelected(null) }}>
              <div className="flex flex-col gap-1 text-sm">
                <strong>{selected.pid_number}</strong>
                <span className="text-xs text-slate-500">{selected.coord_status} · {selected.latitude}, {selected.longitude}</span>
                {canWrite && (
                  <Button size="sm" variant="secondary" onClick={() => onFixLocation(selected)}>Fix location</Button>
                )}
              </div>
            </Popup>
          )}
        </BaseMap>
        <MapLegend items={COORD_STATUS_LEGEND.filter((i) => i.key !== 'MISSING')} title="Coordinate status" className="absolute bottom-4 left-3 z-[400]" />
      </div>
    </div>
  );
}
