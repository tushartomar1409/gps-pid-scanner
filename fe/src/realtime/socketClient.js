// Socket.IO client singleton (GUIDE #9 A2).
// - connect(token) after login, disconnect() on logout; reconnect with the library's default backoff.
// - Events are re-emitted on a small local bus, so React hooks can subscribe before/after the socket exists.
// - status: 'connected' | 'reconnecting' | 'offline'.
// - onResync(cb): fires after every RE-connect (not the first connect); pages refetch their REST snapshot,
//   because deltas sent while disconnected are lost by design.
// - 'unauthorized' (handshake refused, or the server's periodic re-check kicked us) -> onUnauthorized handler.
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined; // undefined = same origin (Vite proxies /socket.io)

export function createSocketClient({ ioFactory = io, url = SOCKET_URL } = {}) {
  let socket = null;
  let status = 'offline';
  let connectedOnce = false;
  let unauthorizedHandler = null;
  const statusListeners = new Set();
  const resyncListeners = new Set();
  const eventListeners = new Map(); // name -> Set<fn>

  const setStatus = (s) => {
    if (s === status) return;
    status = s;
    for (const l of statusListeners) l(s);
  };
  const emitLocal = (name, payload) => {
    for (const fn of eventListeners.get(name) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[realtime] handler for ${name} failed`, err);
      }
    }
  };
  const unauthorized = () => {
    disconnect();
    unauthorizedHandler?.();
  };

  function connect(token) {
    if (socket) disconnect();
    connectedOnce = false;
    socket = ioFactory(url, { path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'], reconnection: true });
    setStatus('reconnecting'); // "connecting" — amber until the handshake completes
    socket.on('connect', () => {
      setStatus('connected');
      if (connectedOnce) for (const cb of resyncListeners) cb();
      connectedOnce = true;
    });
    socket.on('disconnect', (reason) => {
      // 'io client disconnect' = we called disconnect(); 'io server disconnect' = server kicked us (no auto-reconnect)
      setStatus(reason === 'io client disconnect' || reason === 'io server disconnect' ? 'offline' : 'reconnecting');
    });
    socket.on('connect_error', (err) => {
      if (err?.message === 'unauthorized') unauthorized();
      else setStatus('reconnecting');
    });
    socket.io?.on?.('reconnect_failed', () => setStatus('offline'));
    socket.on('unauthorized', unauthorized);
    socket.onAny((name, payload) => emitLocal(name, payload));
    return socket;
  }

  function disconnect() {
    if (!socket) return;
    const s = socket;
    socket = null;
    s.offAny?.();
    s.removeAllListeners?.();
    s.disconnect();
    connectedOnce = false;
    setStatus('offline');
  }

  return {
    connect,
    disconnect,
    getStatus: () => status,
    isConnected: () => Boolean(socket) && status === 'connected',
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    onResync(fn) {
      resyncListeners.add(fn);
      return () => resyncListeners.delete(fn);
    },
    on(name, fn) {
      if (!eventListeners.has(name)) eventListeners.set(name, new Set());
      eventListeners.get(name).add(fn);
      return () => eventListeners.get(name)?.delete(fn);
    },
    setUnauthorizedHandler(fn) {
      unauthorizedHandler = fn;
    },
    /** test seam: deliver an event as if it came from the server */
    emitLocal,
  };
}

export const socketClient = createSocketClient();
