import { memo } from 'react';
import { CircleMarker, Polyline, Tooltip } from 'react-leaflet';
import { MAP_LAYER_COLORS, visitStatusMeta } from '../../utils/visitStatus.js';
import { geometryToLatLngs, segmentLatLngs } from './coverageLogic.js';

export const PidStatusLayer = memo(function PidStatusLayer({ pids, selectedId, onSelect }) {
  return pids.map((p) => {
    const m = visitStatusMeta(p.visit_status);
    const sel = p.pid_id === selectedId;
    return (
      <CircleMarker
        key={p.pid_id}
        center={[p.latitude, p.longitude]}
        radius={sel ? 9 : 6}
        pathOptions={{ color: sel ? '#0072B2' : m.marker.stroke, weight: sel ? 3 : m.marker.weight, dashArray: m.marker.dashArray, fillColor: m.color, fillOpacity: m.marker.fillOpacity }}
        eventHandlers={{ click: (e) => { e.originalEvent?.stopPropagation(); onSelect(p); } }}
      >
        <Tooltip direction="top">{p.pid_number} · {m.symbol} {m.short}</Tooltip>
      </CircleMarker>
    );
  });
});

export function AssignedRouteLayer({ geometry }) {
  return geometryToLatLngs(geometry).map((line, i) => (
    <Polyline key={i} positions={line} pathOptions={{ color: MAP_LAYER_COLORS.assignedRoute.color, weight: 5, opacity: 0.75 }} />
  ));
}

export function TrailLayer({ track }) {
  if (track.length < 2) return null;
  return <Polyline positions={track.map((p) => [p.latitude, p.longitude])} pathOptions={{ color: MAP_LAYER_COLORS.actualTrail.color, weight: 3, opacity: 0.95 }} />;
}

export function OffRouteLayer({ track, segments, activeIndex }) {
  return segments.map((s, i) => {
    const pts = segmentLatLngs(track, s);
    if (pts.length < 1) return null;
    const positions = pts.length === 1 ? [pts[0], pts[0]] : pts;
    return (
      <Polyline key={`${s.from}-${i}`} positions={positions}
        pathOptions={{ color: MAP_LAYER_COLORS.offRoute.color, weight: i === activeIndex ? 7 : 5, dashArray: '8 6', opacity: 0.9 }}>
        <Tooltip sticky>Off route · max {s.max_m} m</Tooltip>
      </Polyline>
    );
  });
}

export function CurrentVehicleMarker({ position, label }) {
  if (!position) return null;
  return (
    <CircleMarker center={position} radius={9} pathOptions={{ color: '#ffffff', weight: 2.5, fillColor: MAP_LAYER_COLORS.currentVehicle.color, fillOpacity: 1 }}>
      <Tooltip direction="top" permanent>{label}</Tooltip>
    </CircleMarker>
  );
}
