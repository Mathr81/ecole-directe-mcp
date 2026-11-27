/**
 * /admin: the owner approves, rejects and revokes users.
 *
 * Authenticated by the server passphrase, then by a signed cookie. Every
 * action is a POST, and the cookie is SameSite=Strict, which is enough to stop
 * another site from triggering one (CSRF) without a token in each form.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { hmacHex } from '../store/secretBox.js';
import { RateLimiter } from '../transport/rateLimiter.js';
import type { MultiUser } from '../users/multiUser.js';
import { renderAdminList, renderAdminLogin } from './adminPages.js';

const COOKIE = 'ed_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

export interface AdminOptions {
  multiUser: MultiUser;
  passphrase: string;
  secureCookie: boolean;
  now?: () => number;
}

function sameSecret(a: string, b: string): boolean {
  // Hash first: timingSafeEqual needs equal lengths and must not leak them.
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

export function mountAdmin(app: Express, options: AdminOptions): void {
  const { multiUser, passphrase, secureCookie } = options;
  const now = options.now ?? Date.now;
  const failures = new RateLimiter(10, 15 * 60 * 1000, now);
  const cookieFlags = `Path=/admin; HttpOnly; SameSite=Strict${secureCookie ? '; Secure' : ''}`;

  const sign = (expiresAt: number) => hmacHex(multiUser.keys, `admin:${expiresAt}`);

  function signedIn(req: Request): boolean {
    const [expiresAt, signature] = (readCookie(req, COOKIE) ?? '').split('.');
    if (!expiresAt || !signature || !(Number(expiresAt) > now())) return false;
    return sameSecret(signature, sign(Number(expiresAt)));
  }

  function html(res: Response, status: number, body: string): void {
    res.status(status).set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(body);
  }

  const form = express.urlencoded({ extended: false, limit: '4kb' });

  app.get('/admin', async (req, res, next) => {
    try {
      if (!signedIn(req)) {
        html(res, 200, renderAdminLogin());
        return;
      }
      await multiUser.users.purgeExpiredPending();
      const users = await multiUser.users.list();
      html(res, 200, renderAdminList(users, users.some((user) => user.isOwner)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/login', form, (req, res) => {
    const ip = req.ip ?? '';
    if (failures.blocked(ip)) {
      html(res, 429, renderAdminLogin('Trop de tentatives, réessaie plus tard.'));
      return;
    }
    const given = String((req.body as { passphrase?: string }).passphrase ?? '');
    if (!given || !sameSecret(given, passphrase)) {
      failures.hit(ip);
      html(res, 401, renderAdminLogin('Phrase secrète incorrecte.'));
      return;
    }
    const expiresAt = now() + SESSION_MS;
    res
      .set('Set-Cookie', `${COOKIE}=${expiresAt}.${sign(expiresAt)}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags}`)
      .redirect(303, '/admin');
  });

  app.post('/admin/logout', form, (_req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags}`).redirect(303, '/admin');
  });

  app.post('/admin/users/:userId/:verb', form, async (req, res, next) => {
    try {
      if (!signedIn(req)) {
        html(res, 401, renderAdminLogin('Session expirée, reconnecte-toi.'));
        return;
      }
      const userId = String(req.params.userId);
      const user = await multiUser.users.get(userId);
      const verb = req.params.verb;
      if (user && !user.isOwner) {
        if (verb === 'approve' && user.status === 'pending') {
          await multiUser.users.save({ ...user, status: 'approved', approvedAt: new Date(now()).toISOString() });
        } else if (verb === 'reject' && user.status === 'pending') {
          await multiUser.removeUser(userId);
        } else if (verb === 'revoke' && user.status === 'approved') {
          await multiUser.removeUser(userId);
        }
      }
      res.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });
}
