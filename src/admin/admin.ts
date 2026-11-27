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
import type { HealthState } from '../health/sessionMonitor.js';
import {
  parseJournalFilter,
  renderAdminLogin,
  renderDashboard,
  renderJournal,
  renderUserDetail,
  renderUsers,
  safeBack,
} from './adminPages.js';

const COOKIE = 'ed_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

export interface AdminOptions {
  multiUser: MultiUser;
  passphrase: string;
  secureCookie: boolean;
  readOnly: boolean;
  /** Last result of the periodic check of the owner's session. */
  health?: () => HealthState;
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
  const startedAt = now();
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

  /** Every admin page: the login form until the cookie is there. */
  function adminPage(path: string, render: (req: Request, res: Response) => Promise<string>): void {
    app.get(path, async (req, res, next) => {
      try {
        if (!signedIn(req)) {
          html(res, 200, renderAdminLogin());
          return;
        }
        await multiUser.users.purgeExpiredPending();
        const body = await render(req, res);
        html(res, res.statusCode, body);
      } catch (error) {
        next(error);
      }
    });
  }

  adminPage('/admin', async () =>
    renderDashboard({
      users: await multiUser.users.list(),
      events: multiUser.activity.events(),
      now: now(),
      health: options.health?.() ?? null,
      startedAt,
      readOnly: options.readOnly,
    }),
  );

  adminPage('/admin/users', async () => renderUsers(await multiUser.users.list(), multiUser.activity.events(), now()));

  adminPage('/admin/users/:userId', async (req, res) => {
    const users = await multiUser.users.list();
    const user = users.find((candidate) => candidate.userId === req.params.userId);
    if (!user) {
      // Gone (rejected, revoked, expired): the list, with the right status.
      res.status(404);
      return renderUsers(users, multiUser.activity.events(), now());
    }
    return renderUserDetail(user, users, multiUser.activity.events(), now());
  });

  adminPage('/admin/activity', async (req) =>
    renderJournal(
      await multiUser.users.list(),
      multiUser.activity.events(),
      now(),
      parseJournalFilter(req.query.kind),
      typeof req.query.user === 'string' ? req.query.user : '',
    ),
  );

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
          await multiUser.activity.record({ type: 'approved', userId });
        } else if (verb === 'reject' && user.status === 'pending') {
          await multiUser.removeUser(userId);
          // No userId: a removed user leaves no trace, only the count remains.
          await multiUser.activity.record({ type: 'rejected' });
        } else if (verb === 'revoke' && user.status === 'approved') {
          await multiUser.removeUser(userId);
          await multiUser.activity.record({ type: 'revoked' });
        }
      }
      // A removed user has no page left to come back to.
      const back = safeBack((req.body as { back?: string }).back);
      res.redirect(303, back.startsWith('/admin/users/') && !(await multiUser.users.get(userId)) ? '/admin/users' : back);
    } catch (error) {
      next(error);
    }
  });
}
