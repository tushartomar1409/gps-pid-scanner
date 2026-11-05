// Small react-leaflet helpers that hook into the map instance.
import { useEffect, useRef } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

/** Calls onChange(bounds, zoom) once on mount and after every pan/zoom (moveend). */
export function BoundsWatcher({ onChange }) {
  const map = useMapEvents({ moveend: () => onChange(map.getBounds(), map.getZoom()) });
  useEffect(() => {
    onChange(map.getBounds(), map.getZoom());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Calls onClick(latlng) for clicks on the map background. */
export function MapClick({ onClick }) {
  useMapEvents({ click: (e) => onClick(e.latlng) });
  return null;
}

/** Fits the map to the given [[lat,lng],...] points once they become available (key changes). */
export function FitToPoints({ points, fitKey, maxZoom = 17 }) {
  const map = useMap();
  const done = useRef(null);
  useEffect(() => {
    if (!points?.length || done.current === fitKey) return;
    done.current = fitKey;
    if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 16));
    else map.fitBounds(L.latLngBounds(points), { padding: [24, 24], maxZoom });
  }, [points, fitKey, map, maxZoom]);
  return null;
}

/**
 * Shift + drag draws a selection rectangle and calls onSelect(L.LatLngBounds).
 * Replaces Leaflet's default shift-drag box *zoom* (disabled while mounted). ~40 lines instead of
 * pulling in leaflet-draw / geoman for one interaction.
 */
export function BoxSelect({ onSelect }) {
  const map = useMap();
  const cb = useRef(onSelect);
  cb.current = onSelect;

  useEffect(() => {
    map.boxZoom.disable();
    const container = map.getContainer();
    let start = null;
    let rect = null;

    const onDown = (e) => {
      if (!e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      map.dragging.disable();
      start = map.mouseEventToLatLng(e);
      rect = L.rectangle(L.latLngBounds(start, start), { color: '#7c3aed', weight: 1, dashArray: '4 4', fillOpacity: 0.08, interactive: false }).addTo(map);
    };
    const onMove = (e) => {
      if (!start) return;
      rect.setBounds(L.latLngBounds(start, map.mouseEventToLatLng(e)));
    };
    const onUp = () => {
      if (!start) return;
      const bounds = rect.getBounds();
      rect.remove();
      rect = null;
      start = null;
      map.dragging.enable();
      if (!bounds.getNorthEast().equals(bounds.getSouthWest())) cb.current(bounds);
    };

    container.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      container.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      rect?.remove();
      map.dragging.enable();
      map.boxZoom.enable();
    };
  }, [map]);
  return null;
}
