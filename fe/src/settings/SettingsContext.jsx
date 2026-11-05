// Public settings from GET /api/settings/public, loaded once after login (GUIDE #6 answer 2).
// Until loaded (or if the call fails) the defaults below are used; the server stays authoritative.
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { settingsApi } from '../api/resources.js';

export const DEFAULT_SETTINGS = Object.freeze({
  serviceAreaBbox: { min_lat: 6, max_lat: 37.5, min_lng: 68, max_lng: 97.5 },
  timezone: 'Asia/Kolkata',
  detectionRadiusM: 30,
  offlineAfterSeconds: 300,
  loaded: false,
});

export function fromApi(data = {}) {
  return {
    serviceAreaBbox: data['geo.service_area_bbox'] ?? DEFAULT_SETTINGS.serviceAreaBbox,
    timezone: data['app.timezone'] ?? DEFAULT_SETTINGS.timezone,
    detectionRadiusM: data['detection.radius_m'] ?? DEFAULT_SETTINGS.detectionRadiusM,
    offlineAfterSeconds: data['gps.offline_after_seconds'] ?? DEFAULT_SETTINGS.offlineAfterSeconds,
    loaded: true,
  };
}

export const SettingsContext = createContext(DEFAULT_SETTINGS);

export function SettingsProvider({ children }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  useEffect(() => {
    if (!user) {
      setSettings(DEFAULT_SETTINGS);
      return undefined;
    }
    let cancelled = false;
    settingsApi
      .public()
      .then(({ data }) => !cancelled && setSettings(fromApi(data)))
      .catch(() => { /* keep defaults; non-critical */ });
    return () => {
      cancelled = true;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- reload per user, not per profile object

  const value = useMemo(() => settings, [settings]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/** Works without a provider too (returns defaults) — convenient for isolated component tests. */
export function useSettings() {
  return useContext(SettingsContext);
}
