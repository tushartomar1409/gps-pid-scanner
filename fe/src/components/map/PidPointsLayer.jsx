import { memo } from 'react';
import { CircleMarker, Tooltip } from 'react-leaflet';
import { COORD_STATUS_STYLES } from '../../utils/mapStyles.js';

/**
 * PIDs as CircleMarkers on the shared canvas renderer (BaseMap preferCanvas) — no DOM node per point.
 * styleFor(point) may override colour/radius (e.g. route builder selected vs muted).
 */
export const PidPointsLayer = memo(function PidPointsLayer({ points, onPointClick, styleFor, showTooltip = true }) {
  return points.map((p) => {
    const s = styleFor ? styleFor(p) : { color: COORD_STATUS_STYLES[p.coord_status]?.color || '#2563eb' };
    return (
      <CircleMarker
        key={p.id}
        center={[p.latitude, p.longitude]}
        radius={s.radius ?? 5}
        pathOptions={{ color: '#ffffff', weight: 1, fillColor: s.color, fillOpacity: s.fillOpacity ?? 0.9 }}
        eventHandlers={onPointClick ? { click: (e) => { e.originalEvent?.stopPropagation(); onPointClick(p); } } : undefined}
      >
        {showTooltip && <Tooltip direction="top">{p.pid_number}</Tooltip>}
      </CircleMarker>
    );
  });
});
