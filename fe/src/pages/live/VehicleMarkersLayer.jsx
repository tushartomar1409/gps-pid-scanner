import { memo, useEffect, useState } from 'react';
import { CircleMarker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { CONNECTION_STATUS } from '../../utils/visitStatus.js';

export const LABEL_ZOOM = 15;

/** Canvas CircleMarkers (BaseMap preferCanvas) — smooth at 2,000 vehicles. Labels at zoom ≥ 15. */
export const VehicleMarkersLayer = memo(function VehicleMarkersLayer({ vehicles, selectedId, onSelect }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const labels = zoom >= LABEL_ZOOM;
  return vehicles
    .filter((v) => v.latitude != null && v.longitude != null)
    .map((v) => {
      const s = CONNECTION_STATUS[v.connection_status] || CONNECTION_STATUS.NO_DATA;
      const selected = v.vehicle_id === selectedId;
      return (
        <CircleMarker
          key={`${v.vehicle_id}-${labels ? 'l' : 'n'}`}
          center={[v.latitude, v.longitude]}
          radius={selected ? 9 : 6}
          pathOptions={{ color: selected ? '#0072B2' : s.stroke, weight: selected ? 3 : s.weight, fillColor: s.fill, fillOpacity: s.fillOpacity }}
          eventHandlers={{ click: (e) => { e.originalEvent?.stopPropagation(); onSelect(v.vehicle_id); } }}
        >
          <Tooltip direction="top" offset={[0, -6]} permanent={labels} className={labels ? 'text-[10px]' : ''}>
            {v.vehicle_number}
            {!labels && ` · ${s.label}`}
          </Tooltip>
        </CircleMarker>
      );
    });
});

/** Flies to [lat,lng] whenever `target` (with a changing `nonce`) is set. */
export function FlyTo({ target, zoom = 16 }) {
  const map = useMap();
  const nonce = target?.nonce;
  useEffect(() => {
    if (!target) return;
    map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), zoom), { duration: 0.8 });
  }, [nonce]); // eslint-disable-line react-hooks/exhaustive-deps -- fly once per request
  return null;
}
