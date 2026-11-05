// GUIDE #9 G2: socket client — unauthorized -> logout redirect; status hook transitions; resync only on RE-connect.
import { describe, it, expect, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { createSocketClient } from '../realtime/socketClient.js';
import { useSocketStatus } from '../realtime/hooks.js';
import { LiveIndicator } from '../components/LiveIndicator.jsx';
import { AuthProvider, useAuth } from '../auth/AuthContext.jsx';
import { authApi } from '../api/auth.js';
import { getToken, setToken } from '../auth/session.js';

vi.mock('../api/auth.js', () => ({ authApi: { profile: vi.fn(), login: vi.fn(), logout: vi.fn() } }));

function fakeIo() {
  const sock = { handlers: {}, managerHandlers: {} };
  Object.assign(sock, {
    on: vi.fn((e, fn) => { sock.handlers[e] = fn; }),
    onAny: vi.fn((fn) => { sock.any = fn; }),
    offAny: vi.fn(),
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    io: { on: vi.fn((e, fn) => { sock.managerHandlers[e] = fn; }) },
  });
  const factory = vi.fn(() => sock);
  return { sock, factory };
}

describe('socket client', () => {
  it('connects with auth.token; status offline -> reconnecting -> connected -> reconnecting -> offline', () => {
    const { sock, factory } = fakeIo();
    const c = createSocketClient({ ioFactory: factory, url: 'http://x' });
    const { result } = renderHook(() => useSocketStatus(c));
    expect(result.current).toBe('offline');
    act(() => { c.connect('jwt-1'); });
    expect(factory).toHaveBeenCalledWith('http://x', expect.objectContaining({ auth: { token: 'jwt-1' }, path: '/socket.io', reconnection: true }));
    expect(result.current).toBe('reconnecting');
    act(() => sock.handlers.connect());
    expect(result.current).toBe('connected');
    act(() => sock.handlers.disconnect('transport close'));
    expect(result.current).toBe('reconnecting');
    act(() => sock.handlers.connect_error(new Error('xhr poll error')));
    expect(result.current).toBe('reconnecting');
    act(() => sock.managerHandlers.reconnect_failed());
    expect(result.current).toBe('offline');
    act(() => sock.handlers.connect());
    act(() => c.disconnect());
    expect(result.current).toBe('offline');
    expect(sock.disconnect).toHaveBeenCalled();
  });

  it('resync fires after a RE-connect only; server events reach useSocketEvent subscribers via the local bus', () => {
    const { sock, factory } = fakeIo();
    const c = createSocketClient({ ioFactory: factory });
    const resync = vi.fn();
    const onLoc = vi.fn();
    c.onResync(resync);
    c.on('vehicle:locations', onLoc);
    c.connect('t');
    sock.handlers.connect();
    expect(resync).not.toHaveBeenCalled();
    sock.handlers.disconnect('ping timeout');
    sock.handlers.connect();
    expect(resync).toHaveBeenCalledTimes(1);
    sock.any('vehicle:locations', [{ vehicle_id: 1 }]);
    expect(onLoc).toHaveBeenCalledWith([{ vehicle_id: 1 }]);
  });

  it('unauthorized (handshake refused or kicked by the re-check) calls the handler and goes offline', () => {
    const { sock, factory } = fakeIo();
    const c = createSocketClient({ ioFactory: factory });
    const onUnauth = vi.fn();
    c.setUnauthorizedHandler(onUnauth);
    c.connect('t');
    sock.handlers.connect_error(new Error('unauthorized'));
    expect(onUnauth).toHaveBeenCalledTimes(1);
    expect(c.getStatus()).toBe('offline');

    const b = fakeIo();
    const c2 = createSocketClient({ ioFactory: b.factory });
    const h2 = vi.fn();
    c2.setUnauthorizedHandler(h2);
    c2.connect('t');
    b.sock.handlers.connect();
    b.sock.handlers.unauthorized({ reason: 'User is no longer active' });
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('LiveIndicator shows Live / Reconnecting… / Offline', () => {
    const { sock, factory } = fakeIo();
    const c = createSocketClient({ ioFactory: factory });
    render(<LiveIndicator client={c} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    act(() => { c.connect('t'); });
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    act(() => sock.handlers.connect());
    expect(screen.getByText('Live')).toBeInTheDocument();
  });
});

describe('AuthProvider + socket', () => {
  function Who() {
    const { user } = useAuth();
    return <p>user:{user ? user.name : 'none'}</p>;
  }

  it('connects after login and on socket unauthorized clears the session and redirects to /login?expired=1', async () => {
    setToken('jwt-abc');
    authApi.profile.mockResolvedValue({ data: { id: 1, name: 'Asha', permissions: [] } });
    const { sock, factory } = fakeIo();
    const client = createSocketClient({ ioFactory: factory });
    render(
      <MemoryRouter initialEntries={['/live']}>
        <AuthProvider realtime={client}>
          <Routes>
            <Route path="/live" element={<Who />} />
            <Route path="/login" element={<LoginProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('user:Asha')).toBeInTheDocument();
    expect(factory).toHaveBeenCalledWith(undefined, expect.objectContaining({ auth: { token: 'jwt-abc' } }));
    act(() => sock.handlers.connect_error(new Error('unauthorized')));
    expect(await screen.findByText('login expired=1')).toBeInTheDocument();
    expect(getToken()).toBeNull();
    await waitFor(() => expect(client.getStatus()).toBe('offline'));
  });
});

function LoginProbe() {
  return <p>login {useLocation().search.slice(1)}</p>;
}
