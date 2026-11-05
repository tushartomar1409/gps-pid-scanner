import { MapContainer, TileLayer } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import { MAP_CONFIG } from '../../config/mapConfig.js';

// Classic Leaflet + bundler issue: the default icon URLs are resolved from CSS at runtime and break
// under Vite. Point them at the bundled assets explicitly.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

/**
 * Configurable base map. `preferCanvas` renders vector layers (our PID CircleMarkers) on one canvas
 * instead of thousands of SVG/DOM nodes.
 */
export function BaseMap({ center = MAP_CONFIG.center, zoom = MAP_CONFIG.zoom, className = 'h-[480px]', children, ...rest }) {
  return (
    <MapContainer
      center={center}
      zoom={zoom}
      maxZoom={MAP_CONFIG.maxZoom}
      preferCanvas
      className={`w-full rounded-lg border border-slate-200 ${className}`}
      {...rest}
    >
      <TileLayer url={MAP_CONFIG.tileUrl} attribution={MAP_CONFIG.attribution} maxZoom={MAP_CONFIG.maxZoom} />
      {children}
    </MapContainer>
  );
}
