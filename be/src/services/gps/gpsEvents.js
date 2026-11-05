// In-process event bus between GPS ingestion and its consumers.
//   'ingested'  { pollRunId, provider, insertedIds: number[], vehicleIds: number[] }
// Phase 4 (PID detection) and Phase 5 (Socket.IO) subscribe here. Phase 3 only emits.
import { EventEmitter } from 'node:events';

export const gpsEvents = new EventEmitter();
gpsEvents.setMaxListeners(20);
