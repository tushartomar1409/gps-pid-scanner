import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthContext.jsx';
import LoginPage from '../pages/LoginPage.jsx';
import { authApi } from '../api/auth.js';
import { getToken } from '../auth/session.js';

vi.mock('../api/auth.js', () => ({
  authApi: { login: vi.fn(), profile: vi.fn(), logout: vi.fn() },
}));

function renderLogin(entry = '/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>HOME PAGE</p>} />
          <Route path="/vehicles" element={<p>VEHICLES PAGE</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const user = { id: 1, name: 'Admin', role_key: 'SUPER_ADMIN', permissions: ['*'] };

describe('LoginPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates required fields and email format without calling the API', async () => {
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(screen.getByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(authApi.login).not.toHaveBeenCalled();
  });

  it('logs in, stores the token and redirects to the safe redirect target', async () => {
    authApi.login.mockResolvedValue({ data: { token: 'jwt-token', user } });
    renderLogin('/login?redirect=%2Fvehicles');
    await userEvent.type(screen.getByLabelText('Email'), 'admin@test.local');
    await userEvent.type(screen.getByLabelText('Password'), 'Secret123');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('VEHICLES PAGE')).toBeInTheDocument();
    expect(authApi.login).toHaveBeenCalledWith('admin@test.local', 'Secret123');
    expect(getToken()).toBe('jwt-token');
  });

  it('ignores an unsafe redirect (open-redirect protection)', async () => {
    authApi.login.mockResolvedValue({ data: { token: 't', user } });
    renderLogin('/login?redirect=%2F%5Cevil.example');
    await userEvent.type(screen.getByLabelText('Email'), 'admin@test.local');
    await userEvent.type(screen.getByLabelText('Password'), 'Secret123');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText('HOME PAGE')).toBeInTheDocument();
  });

  it('shows a generic error on 401 and re-enables the button', async () => {
    authApi.login.mockRejectedValue({ response: { status: 401, data: { success: false, message: 'Invalid email or password' } } });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'admin@test.local');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
    expect(getToken()).toBeNull();
  });

  it('shows the expired-session notice', () => {
    renderLogin('/login?expired=1');
    expect(screen.getByText(/session has expired/i)).toBeInTheDocument();
  });
});
