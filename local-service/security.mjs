import { timingSafeEqual } from 'node:crypto';

export function checkRequest(headers, { host, origins, token }) {
  if (headers.host !== host || !origins.includes(headers.origin)) return false;
  if (typeof headers.authorization !== 'string' || !headers.authorization.startsWith('Bearer ')) return false;
  const actual = Buffer.from(headers.authorization.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
