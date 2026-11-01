import crypto from 'node:crypto';

// Same rule as LemonServer's contest names: must be usable as a folder name everywhere.
const INVALID = /[<>:"/\\|?*\x00-\x1f]/;
export function isValidName(name, max = 64) {
  return typeof name === 'string' && name.length > 0 && name.length <= max && name.trim() === name &&
    name !== '.' && name !== '..' && !INVALID.test(name) && !name.endsWith('.');
}

// Problem names become file names (<name>.cpp) and LemonServer task names.
export function isValidProblemName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_\-]{1,40}$/.test(name);
}

// Contestant accounts are imported by the hundred, so the cost is moderate; the admin's is higher.
export function hashPassword(password, cost = 4096) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: cost });
  return `scrypt$${cost}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function checkPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [kind, costStr, saltHex, hashHex] = stored.split('$');
  const cost = Number(costStr);
  if (kind !== 'scrypt' || !Number.isInteger(cost) || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, { N: cost });
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? Math.round(t) : NaN;
}
