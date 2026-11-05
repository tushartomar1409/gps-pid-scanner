import { useEffect, useRef, useSyncExternalStore } from 'react';
import { socketClient } from './socketClient.js';

/** Subscribes to a server event; the latest handler is always used (no re-subscribe per render). */
export function useSocketEvent(name, handler, client = socketClient) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => client.on(name, (p) => ref.current?.(p)), [name, client]);
}

/** 'connected' | 'reconnecting' | 'offline' */
export function useSocketStatus(client = socketClient) {
  return useSyncExternalStore(client.onStatus, client.getStatus, client.getStatus);
}

/** Runs cb after every socket RE-connect (refetch the REST snapshot). */
export function useResync(cb, client = socketClient) {
  const ref = useRef(cb);
  useEffect(() => {
    ref.current = cb;
  });
  useEffect(() => client.onResync(() => ref.current?.()), [client]);
}
