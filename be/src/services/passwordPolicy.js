// Password policy (GUIDE #11 C2): applied on user create and password change (not on login).
// ≥ 10 characters, ≤ 72 (bcrypt), a letter and a digit, not the email (or its local part), not a common password.

export const MIN_LENGTH = 10;

// Small deny-list of the most common passwords that would otherwise pass the length/letter/digit rules
// (normalised to lowercase). Not exhaustive on purpose: the length rule does most of the work.
const COMMON = new Set([
  'password123', 'password1234', 'passw0rd123', 'password@123', 'p@ssw0rd123', 'admin12345', 'admin@1234', 'administrator1',
  'qwerty12345', 'qwerty123456', '1234567890a', 'a1234567890', 'abc1234567', 'abcd123456', 'welcome123', 'welcome@123',
  'letmein1234', 'iloveyou123', 'changeme123', 'default1234', 'test123456', 'testing1234', 'india12345', 'india@1234',
  'faridabad123', 'haryana1234', 'secret12345', 'monkey12345', 'dragon12345', 'football123', 'superman123', 'trustno1234',
  'gpspid12345', 'portal12345',
]);

export const PASSWORD_RULES = [
  `At least ${MIN_LENGTH} characters (at most 72)`,
  'Contains a letter and a digit',
  'Not your email address',
  'Not a commonly used password',
];

/** Returns a list of violated rules (empty = OK). */
export function passwordProblems(password, email = '') {
  const p = String(password ?? '');
  const problems = [];
  if (p.length < MIN_LENGTH) problems.push(`Password must be at least ${MIN_LENGTH} characters`);
  if (p.length > 72) problems.push('Password must be at most 72 characters');
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) problems.push('Password must contain a letter and a digit');
  const e = String(email ?? '').trim().toLowerCase();
  const local = e.split('@')[0];
  if (e && (p.toLowerCase() === e || (local.length >= 4 && p.toLowerCase() === local))) problems.push('Password must not be your email address');
  if (COMMON.has(p.toLowerCase())) problems.push('This password is too common; choose another one');
  return problems;
}
