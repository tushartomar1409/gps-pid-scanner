// GPS provider registry, keyed by GPS_PROVIDER. Add a real provider by writing an adapter that fulfils
// the contract below and registering its factory here (see workflow-docs/gps-provider-integration.md).
//
// Adapter contract:
// @typedef {object} GpsProviderAdapter
// @property {string} name
// @property {(args: { deviceIds?: string[], signal?: AbortSignal }) => Promise<object[]>} fetchLatest
//           Latest raw record per device (provider shape). Must honour `signal` (timeout/abort).
// @property {(args: { deviceId: string, from: Date|string, to: Date|string, signal?: AbortSignal }) => Promise<object[]>} fetchHistory
// @property {(raw: object) => ({ ok: import('../gpsNormalizationService.js').NormalizedPoint } | { error: string })} normalize
//           Pure field mapping + timestamp parsing. Generic validation (coords, future, speed, device)
//           happens afterwards in gpsNormalizationService.validatePoint.
import { createSimulatorProvider } from './simulatorProvider.js';

const REGISTRY = {
  simulator: createSimulatorProvider,
  // realvendor: createRealVendorProvider,   // <- add real adapters here
};

export const REGISTERED_PROVIDERS = Object.keys(REGISTRY);

/** @returns {GpsProviderAdapter} — throws a clear error for an unknown provider name. */
export function createProvider(name, deps) {
  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(`Unknown GPS_PROVIDER "${name}". Registered providers: ${REGISTERED_PROVIDERS.join(', ')}. `
      + 'See workflow-docs/gps-provider-integration.md to add a real adapter.');
  }
  return factory(deps);
}
