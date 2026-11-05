import bcrypt from 'bcrypt';
import { env } from '../config/env.js';

// Pre-computed hash used when the user does not exist, so failed logins take similar time
// whether or not the email is registered (no user enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', env.BCRYPT_ROUNDS);

export const hashPassword = (plain) => bcrypt.hash(plain, env.BCRYPT_ROUNDS);

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash || DUMMY_HASH);
}
