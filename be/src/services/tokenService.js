import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const ALGORITHM = 'HS256';

/** Payload per GUIDE #2: { sub, role_key, zone_id, ward_id, agency_id } + tv = users.token_version (GUIDE #11 C2). */
export function signToken(user) {
  return jwt.sign(
    {
      role_key: user.role_key,
      zone_id: user.zone_id ?? null,
      ward_id: user.ward_id ?? null,
      agency_id: user.agency_id ?? null,
      tv: user.token_version ?? 0,
    },
    env.JWT_SECRET,
    { algorithm: ALGORITHM, expiresIn: env.JWT_EXPIRES_IN, subject: String(user.id) },
  );
}

export function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: [ALGORITHM] });
}
