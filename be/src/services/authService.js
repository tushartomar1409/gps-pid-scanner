import { env } from '../config/env.js';
import { userRepository } from '../repositories/userRepository.js';
import { verifyPassword } from './passwordService.js';
import { signToken } from './tokenService.js';
import { recordActivity, ACTIONS } from './activityLogService.js';
import { unauthorized, notFound } from '../utils/errors.js';

const GENERIC_LOGIN_ERROR = 'Invalid email or password';

export const authService = {
  async login({ email, password }, ctx) {
    const found = await userRepository.findForLogin(email);
    // Always run bcrypt (dummy hash when user missing) to keep timing uniform.
    const passwordOk = await verifyPassword(password, found?.password_hash);

    if (!found || !passwordOk || found.status !== 'ACTIVE') {
      await recordActivity(ctx, {
        action: ACTIONS.LOGIN_FAILED,
        module: 'auth',
        referenceId: found?.id ?? null,
        details: {
          email: String(email).toLowerCase(),
          reason: !found ? 'UNKNOWN_EMAIL' : !passwordOk ? 'BAD_PASSWORD' : `STATUS_${found.status}`,
        },
      });
      throw unauthorized(GENERIC_LOGIN_ERROR);
    }

    const user = await userRepository.findById(found.id);
    await userRepository.touchLastLogin(user.id);
    await recordActivity({ ...ctx, user }, { action: ACTIONS.LOGIN, module: 'auth', referenceId: user.id });

    return {
      token: signToken(user),
      token_type: 'Bearer',
      expires_in: env.JWT_EXPIRES_IN,
      user: await authService.profile(user.id),
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
};
