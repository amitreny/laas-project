import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

// scrypt is deliberately slow and memory-hard, so a stolen database can't be brute-forced quickly.
// The parameters are stored with each hash, so they can be raised later without breaking old ones.
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

/** Returns `scrypt$N$r$p$salt$hash` (base64url), e.g. for storing in users.password_hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); // unique per password, so equal passwords get different hashes
  const hash = await scryptAsync(password, salt, KEYLEN, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  // Constant-time comparison: don't leak how many leading bytes matched.
  return timingSafeEqual(actual, expected);
}

// Used when the email doesn't exist, so "no such user" takes as long as "wrong password"
// and response times can't be used to discover which emails have accounts.
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));
