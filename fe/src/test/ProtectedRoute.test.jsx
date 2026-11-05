import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { ProtectedRoute } from '../auth/ProtectedRoute.jsx';
import { authApi } from '../api/auth.js';
import { setToken } from '../auth/session.js';

vi.mock('../api/auth.js', () => ({
  authApi: { login: vi.fn(), profile: vi.fn(), logout: vi.fn() },
}));

function LoginProbe() {
  const loc = useLocation();
  return <p>LOGIN {loc.search}</p>;
}

function renderAt(path, permission) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<ProtectedRoute permission={permission} />}>
            <Route path="/vehicles" element={<p>SECRET VEHICLES</p>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('redirects to /login with the original path when there is no session', () => {
    renderAt('/vehicles?status=ACTIVE');
    expect(screen.queryByText('SECRET VEHICLES')).not.toBeInTheDocument();
    expect(screen.getByText(/LOGIN/)).toHaveTextContent('LOGIN ?redirect=%2Fvehicles%3Fstatus%3DACTIVE');
    expect(authApi.profile).not.toHaveBeenCalled();
  });

  it('redirects when the stored token is rejected by /auth/profile', async () => {
    setToken('stale');
    authApi.profile.mockRejectedValue({ response: { status: 401 } });
    renderAt('/vehicles');
    expect(await screen.findByText(/LOGIN/)).toBeInTheDocument();
  });

  it('renders children after restoring a valid session', async () => {
    setToken('good');
    authApi.profile.mockResolvedValue({ data: { id: 1, name: 'A', permissions: ['vehicles:read'] } });
    renderAt('/vehicles', 'vehicles:read');
    expect(await screen.findByText('SECRET VEHICLES')).toBeInTheDocument();
  });

  it('shows access denied when the permission is missing', async () => {
    setToken('good');
    authApi.profile.mockResolvedValue({ data: { id: 1, name: 'A', permissions: ['zones:read'] } });
    renderAt('/vehicles', 'vehicles:read');
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('SECRET VEHICLES')).not.toBeInTheDocument();
  });
});
