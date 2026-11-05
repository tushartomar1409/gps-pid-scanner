import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { safeRedirect } from '../auth/session.js';
import { Input } from '../components/Input.jsx';
import { Button } from '../components/Button.jsx';
import { parseApiError } from '../utils/apiErrors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateLogin({ email, password }) {
  const errors = {};
  if (!email.trim()) errors.email = 'Email is required';
  else if (!EMAIL_RE.test(email.trim())) errors.email = 'Enter a valid email address';
  if (!password) errors.password = 'Password is required';
  return errors;
}

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = safeRedirect(searchParams.get('redirect'));
  const expired = searchParams.get('expired') === '1';

  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to={redirectTo} replace />;

  const set = (k) => (e) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    setErrors((er) => ({ ...er, [k]: undefined }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    const found = validateLogin(values);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSubmitting(true);
    try {
      await login(values.email.trim(), values.password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      const { status, message } = parseApiError(err);
      // Generic message for bad credentials — never reveal whether the email exists.
      if (status === 401 || status === 400) setFormError('Invalid email or password');
      else if (status === 429) setFormError(message);
      else setFormError(status === 0 ? message : 'Login failed. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-emerald-900 to-slate-900 px-4 py-12">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl sm:p-8">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-slate-900">GPS PID Monitoring Portal</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to continue</p>
        </div>

        {expired && !formError && (
          <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
            Your session has expired. Please sign in again.
          </p>
        )}
        {searchParams.get('signedOutAll') === '1' && !formError && (
          <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
            You have been signed out on all devices.
          </p>
        )}
        {formError && (
          <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {formError}
          </p>
        )}

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Input label="Email" type="email" autoComplete="username" value={values.email} onChange={set('email')} error={errors.email} />
          <Input label="Password" type="password" autoComplete="current-password" value={values.password} onChange={set('password')} error={errors.password} />
          <Button type="submit" loading={submitting} className="mt-2 w-full">
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
