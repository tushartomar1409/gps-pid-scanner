import { env } from '../config/env.js';
import { db, withTransaction } from '../config/database.js';
import { userRepository } from '../repositories/userRepository.js';
import { verifyPassword } from './passwordService.js';
import { signToken } from './tokenService.js';
import { recordActivity, ACTIONS } from './activityLogService.js';
import { bumpTokenVersion } from './userService.js';
import { unauthorized, notFound } from '../utils/errors.js';

const GENERIC_LOGIN_ERROR = 'Invalid email or password';
export const LOCKOUT = Object.freeze({ maxFailures: 10, windowMinutes: 15, lockMinutes: 15 });

/**
 * Per-account failure counter (GUIDE #11 C2), one atomic statement: a failure outside the current 15-min
 * window starts a new window; the 10th failure inside it locks the account for 15 min.
 */
async function registerFailure(userId) {
  const { rows: [r] } = await db.query(
    `WITH cur AS (
       SELECT id, (failed_login_window_start IS NULL OR failed_login_window_start < now() - make_interval(mins => $2)) AS fresh
         FROM users WHERE id = $1)
     UPDATE users u SET
       failed_login_count = CASE WHEN cur.fresh THEN 1 ELSE u.failed_login_count + 1 END,
       failed_login_window_start = CASE WHEN cur.fresh THEN now() ELSE u.failed_login_window_start END,
       locked_until = CASE WHEN (CASE WHEN cur.fresh THEN 1 ELSE u.failed_login_count + 1 END) >= $3
                           THEN now() + make_interval(mins => $4) ELSE u.locked_until END
       FROM cur WHERE u.id = cur.id
     RETURNING u.failed_login_count, u.locked_until, (u.failed_login_count = $3) AS just_locked`,
    [userId, LOCKOUT.windowMinutes, LOCKOUT.maxFailures, LOCKOUT.lockMinutes]);
  return r;
}

export const authService = {
  async login({ email, password }, ctx) {
    const found = await userRepository.findForLogin(email);
    // Always run bcrypt (dummy hash when user missing) to keep timing uniform — also for locked accounts.
    const passwordOk = await verifyPassword(password, found?.password_hash);

    if (!found || found.is_locked || !passwordOk || found.status !== 'ACTIVE') {
      const reason = !found ? 'UNKNOWN_EMAIL' : found.is_locked ? 'ACCOUNT_LOCKED' : !passwordOk ? 'BAD_PASSWORD' : `STATUS_${found.status}`;
      const fail = found && !found.is_locked && !passwordOk ? await registerFailure(found.id) : null;
      await recordActivity(ctx, {
        action: ACTIONS.LOGIN_FAILED, module: 'auth', referenceId: found?.id ?? null,
        details: { email: String(email).toLowerCase(), reason, ...(fail ? { failures_in_window: fail.failed_login_count } : {}) },
      });
      if (fail?.just_locked) {
        await recordActivity(ctx, {
          action: 'ACCOUNT_LOCKED', module: 'auth', referenceId: found.id,
          details: { failures: fail.failed_login_count, locked_until: fail.locked_until, minutes: LOCKOUT.lockMinutes },
        });
      }
      throw unauthorized(GENERIC_LOGIN_ERROR); // same message whatever the reason (no account enumeration)
    }

    await db.query('UPDATE users SET failed_login_count = 0, failed_login_window_start = NULL, locked_until = NULL WHERE id = $1 AND failed_login_count > 0', [found.id]);
    const auth = await userRepository.findAuthById(found.id);
    await userRepository.touchLastLogin(found.id);
    await recordActivity({ ...ctx, user: auth }, { action: ACTIONS.LOGIN, module: 'auth', referenceId: found.id });

    return {
      token: signToken(auth),
      token_type: 'Bearer',
      expires_in: env.JWT_EXPIRES_IN,
      user: await authService.profile(found.id),
    };
  },

  async profile(userId) {
    const user = await userRepository.findById(userId);
    if (!user) throw notFound('User not found');
    const auth = await userRepository.findAuthById(userId);
    return { ...user, permissions: auth.permissions };
  },

  async logout(ctx) {
    // Stateless JWT: the client discards the token; we only audit the event.
    await recordActivity(ctx, { action: ACTIONS.LOGOUT, module: 'auth', referenceId: ctx.user.id });
  },

  /** "Log out all sessions": every token issued so far (all devices) stops working. */
  async logoutAll(ctx) {
    await withTransaction(async (tx) => {
      await bumpTokenVersion(ctx.user.id, tx);
      await recordActivity(ctx, { action: 'LOGOUT_ALL', module: 'auth', referenceId: ctx.user.id }, tx);
    });
  },
};
