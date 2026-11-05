// Verifies the Bearer JWT and loads the *current* user + role permissions from the DB, so
// deactivated users and role changes take effect immediately (not only at token expiry).
import { verifyToken } from '../services/tokenService.js';
import { userRepository } from '../repositories/userRepository.js';
import { unauthorized } from '../utils/errors.js';

export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw unauthorized('Invalid or expired token');
  }

  const user = await userRepository.findAuthById(Number(payload.sub));
  if (!user || user.status !== 'ACTIVE') throw unauthorized('Invalid or expired token');
  // token_version (GUIDE #11 C2): a password change, deactivation or 'log out all sessions' revokes old tokens.
  if ((payload.tv ?? 0) !== user.token_version) throw unauthorized('Session ended. Please log in again.');

  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role_key: user.role_key,
    permissions: user.permissions,
    zone_id: user.zone_id,
    ward_id: user.ward_id,
    agency_id: user.agency_id,
  };
  next();
}
