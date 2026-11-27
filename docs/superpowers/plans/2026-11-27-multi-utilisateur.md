# Multi-utilisateur Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In OAuth mode, every person logs in with their own École Directe account during the OAuth flow, waits for the owner's approval, then reaches only their own data.

**Architecture:** Each user gets one AES-256-GCM-encrypted file under `/data/users/`. OAuth codes and tokens carry a `userId`. Each request gets a per-user `{ sessionBox, client }` runtime injected into the existing `ToolContext`, so the tools do not change. A passphrase-protected `/admin` page approves, rejects and revokes users. stdio mode and HTTP-without-OAuth stay single-account and do not change.

**Tech Stack:** TypeScript, Node 22 (`node:crypto` HKDF/AES-GCM/HMAC), Express 5, `@modelcontextprotocol/sdk` 1.30.0, vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-multi-utilisateur-design.md` (read it first, it holds the why).

## Global Constraints

- No new npm dependency.
- The École Directe password is never written to disk or logged. It lives in memory only, in the pending OAuth request (max 10 min, `PENDING_TTL_MS`).
- No background refresh for regular users. The periodic check (`SessionMonitor`) only touches the owner.
- `READ_ONLY` defaults unchanged (true over HTTP).
- Only accounts with `accountKind === 'E'` are accepted. Others get « Seuls les comptes élèves sont pris en charge pour l'instant. »
- Limits: 5 failed logins per username per 15 min; 20 login attempts per IP per hour; 10 failed admin logins per IP per 15 min; max 20 `pending` users at once; `pending` users purged after 7 days; DCR clients older than 24 h with no live code/token purged.
- Admin cookie: name `ed_admin`, 12 h, `HttpOnly`, `SameSite=Strict`, `Path=/admin`, `Secure` when `MCP_PUBLIC_URL` is https.
- Webhook body: `{ "content": "<displayName> demande l'accès à École Directe MCP : <origin>/admin" }`, 5 s timeout, failures logged to stderr, never thrown.
- All user-facing copy in French, tutoiement, matching existing pages.
- `trust proxy` stays `1`.
- Work on branch `feat/multi-utilisateur` (create it from `main` before Task 1). Run `npm test` and `npm run typecheck` before each commit.

## Review Focus

1. **A friend connects a second time (re-added connector, second AI):** they must land on the same user (same `userId`), the session is updated, the cached runtime is dropped, and tokens from both connections work. Test in Task 6.
2. **Username typed with different case or spaces** (`" JDupont"` vs `jdupont`): same user. Test in Task 1.
3. **User file unreadable** (key changed, truncated file): `list()` skips it with a stderr line, `get()` returns null, the server does not crash. Test in Task 1.
4. **École Directe down or a network error during login:** the login page shows « École Directe ne répond pas, réessaie plus tard. » with status 502, no 500, and it does not count as a credential failure. Test in Task 6.
5. **QCM page submitted after the pending request expired or was consumed:** shows « Demande expirée ou inconnue. Relance la connexion depuis ton IA. », no École Directe call. Test in Task 6.

---

### Task 1: Config, encryption and user store

**Files:**
- Modify: `src/config.ts`
- Create: `src/store/secretBox.ts`, `src/store/userStore.ts`
- Test: `test/config.test.ts`, `test/store/secretBox.test.ts`, `test/store/userStore.test.ts`

**Interfaces:**
- Produces:
  - `Config.multiUser: { encryptionKey: string; notifyWebhookUrl: string; ownerUsername: string; usersDir: string }`. Read from env `SESSION_ENCRYPTION_KEY`, `NOTIFY_WEBHOOK_URL`, `OWNER_ED_USERNAME`; `usersDir = join(dirname(sessionPath), 'users')`. All default to `''`, except `usersDir`.
  - `secretBox.ts`: `interface Keys { encryption: Buffer; hmac: Buffer }`; `deriveKeys(hexKey: string): Keys`; `interface Sealed { v: 1; iv: string; tag: string; data: string }`; `seal(keys: Keys, value: unknown): Sealed`; `open<T>(keys: Keys, sealed: Sealed): T`; `hmacHex(keys: Keys, value: string): string`.
  - `userStore.ts`: `type UserStatus = 'pending' | 'approved'`; `interface UserRecord { userId: string; username: string; displayName: string; accountKind: string; status: UserStatus; isOwner: boolean; createdAt: string; approvedAt?: string; deviceUUID: string; session: Session | null }`; `class UserStore { constructor(dir: string, keys: Keys, now?: () => number); idFor(username: string): string; get(userId: string): Promise<UserRecord | null>; findByUsername(username: string): Promise<UserRecord | null>; save(record: UserRecord): Promise<void>; delete(userId: string): Promise<void>; list(): Promise<UserRecord[]>; owner(): Promise<UserRecord | null>; countPending(): Promise<number>; purgeExpiredPending(maxAgeMs?: number): Promise<string[]> }`.

- [ ] **Step 1: Write the failing tests**

`test/store/secretBox.test.ts`:
- `deriveKeys throws on a key that is not 64 hex characters`: `expect(() => deriveKeys('abc')).toThrow(/SESSION_ENCRYPTION_KEY/)`.
- `seal/open round-trips`: `open(keys, seal(keys, { a: 1 }))` equals `{ a: 1 }`; two `seal` of the same value give different `iv`.
- `open fails with another key or a tampered payload`: `open(otherKeys, sealed)` throws; flip one char of `sealed.data` → throws.
- `hmacHex is stable and key-dependent`: same input, same key → equal; other key → different.

`test/store/userStore.test.ts` (temp dir, `deriveKeys('11'.repeat(32))`, `makeSession` from the fake):
- `idFor normalises case and whitespace`: `store.idFor(' JDupont ') === store.idFor('jdupont')`.
- `save then get and findByUsername return the record`.
- `the file on disk contains neither the username nor the token`: read raw `users/<id>.json`; `expect(raw).not.toContain('jdupont')`, `not.toContain('fake-access-token')`.
- `get returns null and list skips a file sealed with another key`: write a record with store A, read with store B (other key) → `get` null, `list()` `[]`, no throw.
- `list skips a truncated file`: write `'{'` to `users/x.json` → `list()` returns the other valid records only.
- `owner returns the isOwner record or null`.
- `purgeExpiredPending deletes pending records older than 7 days and keeps approved ones`: `now` injected; pending created 8 days ago → deleted, returned id; approved created 8 days ago → kept.
- `countPending counts only pending`.

`test/config.test.ts`: `multiUser defaults to empty strings and usersDir sits next to the session` (`SESSION_PATH=/data/session.json` → `usersDir === '/data/users'`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/store test/config.test.ts`
Expected: FAIL (modules / properties missing).

- [ ] **Step 3: Implement**

- `deriveKeys`: validate `/^[0-9a-f]{64}$/i`, else throw `"SESSION_ENCRYPTION_KEY doit faire 64 caractères hexadécimaux (openssl rand -hex 32)."`. Then `hkdfSync('sha256', key, '', info, 32)` with info `'ecoledirecte-mcp:encryption'` and `'ecoledirecte-mcp:hmac'`.
- `seal`: AES-256-GCM, 12-byte random IV, base64 fields.
- `UserStore`: file `join(dir, `${userId}.json`)`, written with `writeJsonAtomic(path, seal(keys, record))`. `idFor = hmacHex(keys, username.trim().toLowerCase())`. `get` catches ENOENT/parse/decrypt errors → `null` (stderr line `Fichier utilisateur illisible : <file>` for non-ENOENT). `list` = `readdir` of `*.json` + `get`. `purgeExpiredPending` default `7 * 24 * 60 * 60 * 1000`, compares `createdAt`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/store test/config.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/store/secretBox.ts src/store/userStore.ts test/config.test.ts test/store
git commit -m "feat: encrypted per-user store for multi-user mode"
```

### Task 2: Rate limiter and webhook notifier

**Files:**
- Create: `src/transport/rateLimiter.ts`, `src/notify/webhook.ts`
- Test: `test/transport/rateLimiter.test.ts`, `test/notify/webhook.test.ts`

**Interfaces:**
- Produces:
  - `class RateLimiter { constructor(limit: number, windowMs: number, now?: () => number); blocked(key: string): boolean; hit(key: string): void; reset(key: string): void }`. Fixed window per key, the window starts at the first `hit`. `blocked` is true once `hit` count ≥ `limit` within the window. Expired entries are dropped on `hit`.
  - `type Notifier = (text: string) => Promise<void>`; `createNotifier(url: string, fetchImpl?: typeof fetch): Notifier`. With `url === ''` it returns a no-op.

- [ ] **Step 1: Write the failing tests**
- `RateLimiter blocks after limit hits and unblocks after the window`: limit 5 / 15 min; 4 hits → not blocked; 5th → blocked; `now += 15 min + 1` → not blocked.
- `keys are independent; reset clears one key`.
- `createNotifier posts { content } as JSON`: fake fetch records `(url, init)`; `JSON.parse(init.body)` equals `{ content: 'x' }`, header `Content-Type: application/json`.
- `createNotifier swallows a failing fetch`: fake fetch rejects → `await expect(notify('x')).resolves.toBeUndefined()`.
- `createNotifier('') never calls fetch`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/transport/rateLimiter.test.ts test/notify` → FAIL.
- [ ] **Step 3: Implement** — notifier uses `signal: AbortSignal.timeout(5000)` and `console.error` on failure, including a non-2xx status.
- [ ] **Step 4: Run to verify pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: in-memory rate limiter and webhook notifier"`

### Task 3: OAuth store carries the user

**Files:**
- Modify: `src/oauth/store.ts`
- Test: `test/oauth/store.test.ts` (new)

**Interfaces:**
- Produces: `StoredCode.userId?: string`, `StoredToken.userId?: string` (optional: tokens issued before migration have none and mean "owner"); `OAuthStore.revokeUser(userId: string): Promise<void>` deletes every access and refresh token and code with that `userId`. `prune()` also deletes clients whose `client_id_issued_at` is older than 24 h and that no code or token references.

- [ ] **Step 1: Write the failing tests**
- `issueTokens keeps userId and findAccessToken returns it`.
- `revokeUser removes only that user's tokens`: tokens for `u1` and `u2`; `revokeUser('u1')` → `findAccessToken(t1)` undefined, `findAccessToken(t2)` defined; `consumeRefreshToken(r1)` undefined.
- `stale unused clients are pruned, used ones are kept`: `now` injected; client A registered 25 h ago without tokens, client B registered 25 h ago with a live refresh token; after any mutation (e.g. `saveClient(C)`) → `getClient(A)` undefined, `getClient(B)` defined.

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/oauth/store.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `store.ts` (no API change for existing callers).
- [ ] **Step 4: Run to verify pass** — `npx vitest run test/oauth test/transport/oauth.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: OAuth tokens remember their user; prune stale DCR clients"`

### Task 4: Per-user runtimes

**Files:**
- Create: `src/users/userRuntimes.ts`
- Test: `test/users/userRuntimes.test.ts`

**Interfaces:**
- Consumes: `UserStore`, `UserRecord` (Task 1); `createClient` (`src/client/createClient.ts`), `createSessionBox`, `writeSession`.
- Produces:
  - `interface UserRuntime { userId: string; isOwner: boolean; sessionBox: SessionBox; client: EcoleDirecteClient }`
  - `class UserRuntimes { constructor(options: { users: UserStore; base: EcoleDirecteClient; sessionMaxAgeMs: number; ownerSessionMirrorPath?: string; onAuthLost: (userId: string) => Promise<void> }); get(userId: string): Promise<UserRuntime | null>; forget(userId: string): void }`
  - `get` returns null when the record is missing, not `approved`, or has `session === null`. Otherwise it builds the runtime once and caches it by `userId`.
  - The `sessionBox` persist does read the record → `save({ ...record, session })`, and for the owner with `ownerSessionMirrorPath` set also `writeSession(session, ownerSessionMirrorPath)`.
  - The client is `createClient(base, sessionBox, { sessionMaxAgeMs })` wrapped so that any method rejecting with `AuthenticationRequiredError` first awaits `onAuthLost(userId)`, calls `forget(userId)`, then rejects with `new AuthenticationRequiredError("Ta session École Directe a expiré : déconnecte puis reconnecte le connecteur dans ton IA.")`.

- [ ] **Step 1: Write the failing tests**
- `get returns null for a pending user and for an unknown id`.
- `get returns the same runtime twice, and a fresh one after forget`.
- `two users never share a cache entry or a session`: users A (`username: 'a'`) and B; `runtimeA.client.getGrades(runtimeA.sessionBox.get()!)` and the same for B; the fake records `lastArgs`; assert each call received its own session `username`.
- `a refreshed session is persisted in the user's file`: `fake.refreshedSession = makeSession({ username: 'a', token: 'new' })`, queue `TokenExpiredError` on `getGrades`, call → `(await users.get(idA))!.session!.token === 'new'`.
- `the owner's session is mirrored to session.json`: owner runtime + mirror path; after the refresh above, `readSession(mirrorPath)!.token === 'new'`. A non-owner never writes it.
- `an unrecoverable session calls onAuthLost and forgets the runtime`: queue `TokenExpiredError` on `getGrades` and on `refreshSession` → rejects with message containing `reconnecte le connecteur`; `onAuthLost` called with `idA`; the next `get(idA)` builds a new runtime.

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/users` → FAIL.
- [ ] **Step 3: Implement** — wrapper: a `Proxy` over the client whose `get` trap wraps function properties (comment the why in one line).
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: per-user session box and client runtimes"`

### Task 5: Owner migration and multi-user wiring object

**Files:**
- Create: `src/users/ownerMigration.ts`, `src/users/multiUser.ts`
- Test: `test/users/ownerMigration.test.ts`, `test/users/multiUser.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `readSession` (`src/store/sessionStore.ts`).
- Produces:
  - `syncOwnerFromSessionFile(users: UserStore, sessionPath: string, now?: () => number): Promise<'imported' | 'reimported' | 'unchanged' | 'none'>`
    - `'none'`: no usable `session.json`.
    - `'imported'`: no owner yet → save `{ userId: users.idFor(s.username), username, displayName, accountKind, status: 'approved', isOwner: true, createdAt/approvedAt: now, deviceUUID: s.deviceUUID, session: s }`.
    - `'reimported'`: the owner has the same username and the file's `updatedAt` is strictly newer than `owner.session?.updatedAt` → save it with the new session.
    - `'unchanged'` otherwise.
  - `interface MultiUser { keys: Keys; users: UserStore; oauthStore: OAuthStore; runtimes: UserRuntimes; loginClient: EcoleDirecteClient; notify: Notifier; ownerUsername: string; removeUser(userId: string): Promise<void> }`
  - `createMultiUser(config: Config, base: EcoleDirecteClient, options?: { fetchImpl?: typeof fetch }): Promise<MultiUser>`
    - Throws if `config.multiUser.encryptionKey` is empty: `"Le mode OAuth est multi-utilisateur : définis SESSION_ENCRYPTION_KEY (openssl rand -hex 32)."`
    - Builds the store, `OAuthStore(config.oauth.storePath)` and runtimes (`ownerSessionMirrorPath = config.sessionPath`, `onAuthLost = oauthStore.revokeUser`).
    - Runs `syncOwnerFromSessionFile` (logs the outcome to stderr when not `'none'`/`'unchanged'`) and `purgeExpiredPending()`.
    - `removeUser`: `users.delete` + `oauthStore.revokeUser` + `runtimes.forget` + `rm(join(config.downloadDir, userId), { recursive: true, force: true })`.

- [ ] **Step 1: Write the failing tests**
- `imports session.json as approved owner when there is no owner`.
- `reimports a newer session.json for the same username` and `ignores an older one` (→ `'unchanged'`, token unchanged).
- `returns none without session.json`.
- `createMultiUser refuses to start without an encryption key` (rejects matching `/SESSION_ENCRYPTION_KEY/`).
- `removeUser deletes the file, the tokens and the download folder`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/users` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: owner migration from session.json and multi-user wiring"`

### Task 6: École Directe login inside the OAuth flow

**Files:**
- Modify: `src/oauth/provider.ts`, `src/transport/http.ts` (OAuth mounting only)
- Rename + rewrite: `src/oauth/consentPage.ts` → `src/oauth/pages.ts`
- Create: `test/fakes/multiUserFake.ts`
- Modify test: `test/transport/oauth.test.ts`

**Interfaces:**
- Consumes: `MultiUser` (Task 5), `RateLimiter` (Task 2).
- Produces:
  - `StartHttpServerOptions.multiUser?: MultiUser`. `startHttpServer` throws when `config.oauth.enabled && !options.multiUser`, with the same message as `createMultiUser`.
  - `export const LOGIN_PATH = '/oauth/login'`, `export const TWO_FACTOR_PATH = '/oauth/qcm'` (replace `CONSENT_PATH`).
  - `EcoleDirecteOAuthProvider` options: `{ multiUser: MultiUser; resourceUrl: string; adminUrl: string; now?: () => number }` (passphrase removed).
  - Methods:
    - `handleLogin(res: Response, input: { pending: string; username: string; password: string; ip: string }): Promise<void>`
    - `handleTwoFactor(res: Response, input: { pending: string; answer: string; ip: string }): Promise<void>`
    - `verifyAccessToken` returns `extra: { userId: entry.userId ?? null }`. Codes and tokens are issued with `userId`.
  - `PendingAuthorization` gains `challenge?: TwoFactorChallenge` and `credentials?: LoginCredentials`, both deleted as soon as the QCM finishes or fails for good.
  - `pages.ts`:
    - `renderShell(title: string, body: string): string` (existing styles)
    - `renderLoginPage({ pendingId, clientName, error? })`
    - `renderTwoFactorPage({ pendingId, question, propositions, error? })` (radio inputs named `answer`)
    - `renderMessagePage({ title, message })`
    - `escapeHtml` exported.
  - `test/fakes/multiUserFake.ts`:
    - `class PerUserFake extends FakeEcoleDirecteClient`: `login` returns `makeSession({ username, displayName: username, accountId: username, token: 'tok-' + username, accessToken: 'acc-' + username })`, or `twoFactorChallenge` if set; `completeTwoFactor` does the same; `getGrades(session)` returns one grade whose `label === session.username`; `accountKindFor?: (username) => string` overrides `accountKind`.
    - `buildMultiUser(tempDir, fake, env?)` returns `{ config, multiUser }`.

Login decision, after a successful `login`/`completeTwoFactor` (order matters):
1. `session.accountKind !== 'E'` → message page « Seuls les comptes élèves sont pris en charge pour l'instant. », status 403. Nothing is saved, no webhook.
2. Existing user `approved` → save the new session (keep `deviceUUID`), `runtimes.forget(userId)`, issue the code with `userId`, 302 to `redirect_uri`.
3. No owner yet and `username` matches `ownerUsername` (normalised) → create the owner `approved` + `isOwner`, then as in 2.
4. Existing user `pending` → save the session; message page « Ta demande est toujours en attente de validation. », status 200.
5. New user: if `countPending() >= 20` → « Trop de demandes en attente pour le moment, réessaie plus tard. », status 503. Otherwise create `pending`, `notify(...)` (Global Constraints format), and show the message page titled « Demande envoyée » with « Le propriétaire du serveur doit valider ton accès. Une fois validé, relance la connexion depuis ton IA. », status 200.

Before calling École Directe:
- `ipLimiter.blocked(ip) || userLimiter.blocked(normalisedUsername)` → login page with « Trop de tentatives, réessaie plus tard. », 429, no École Directe call.
- Otherwise `ipLimiter.hit(ip)`.

Errors:
- `InvalidCredentialsError` → `userLimiter.hit`, « Identifiant ou mot de passe incorrect. », 401.
- `InvalidTwoFactorAnswerError` → `userLimiter.hit`, pending request burnt, « Réponse incorrecte. Relance la connexion depuis ton IA. », 401.
- Any other error → « École Directe ne répond pas, réessaie plus tard. », 502.
- Unknown or expired `pending` on either POST → « Demande expirée ou inconnue. Relance la connexion depuis ton IA. », 400.

`deviceUUID` for the login: the existing user's, else `randomUUID()` (stored on the record created in 3 or 5).

Login page notice (copy):
> « Ce serveur garde ta session École Directe chiffrée, jamais ton mot de passe. Tes données passent par l'IA que tu connectes. Le propriétaire du serveur gère les accès : demande-lui pour être supprimé. »

The `MAX_PASSPHRASE_ATTEMPTS` counter becomes 5 failed logins per pending request (then the request is burnt, « Trop de tentatives. Relance la connexion depuis ton IA. »).

- [ ] **Step 1: Rewrite `test/transport/oauth.test.ts` to the new flow (failing)**

`authorizeAndConsent` becomes `authorizeAndLogin(port, clientId, challenge, username = 'jdupont')`: GET `/authorize` → extract `pending`; POST `/oauth/login` with `{ pending, username, password: 'pw' }`. Keep the discovery, PKCE, code-burn, refresh-rotation and restart tests on top of it, with the owner pre-imported through `session.json` (username `jdupont`). New tests:
- `a new user gets a pending page, no code, and a webhook`: login `ami` → status 200, body contains `Demande envoyée`, no `location`; fake fetch got one call whose content contains `ami` and `/admin`; `(await users.findByUsername('ami'))!.status === 'pending'`.
- `a pending user logging in again sees still pending`.
- `an approved user gets a code tied to their userId`: approve `ami` via `users.save`; full flow → token; `oauthStore.findAccessToken(token)!.userId === users.idFor('ami')`.
- `reconnecting an approved user keeps the same userId and both tokens work` (Review Focus 1).
- `a non-student account is refused before any record or webhook`: `fake.accountKindFor = () => '1'` → 403, body contains `comptes élèves`, `users.list()` has no new record, fetch not called.
- `wrong credentials: 401 and the 6th attempt is blocked without calling École Directe`: queue `InvalidCredentialsError` ×5 on `login` (new pending each time) → five 401s; 6th → 429 and `fake.callCounts.login === 5`.
- `École Directe down: 502 and not counted as a credential failure` (Review Focus 4): queue `SchoolUnavailableError` → 502, body contains `ne répond pas`; then 5 queued `InvalidCredentialsError` still give 401 on attempt 5 (not 429 earlier).
- `QCM flow`: `fake.twoFactorChallenge = { token: 't', question: 'Q ?', propositions: ['A', 'B'] }` → login answers 200 with `Q ?` and both radios; POST `/oauth/qcm` `{ pending, answer: 'A' }` → owner flow ends in 302.
- `QCM on an expired or consumed pending request` (Review Focus 5): POST `/oauth/qcm` with an unknown `pending` → 400 `Demande expirée`, `fake.callCounts.completeTwoFactor` undefined.
- `the password never reaches the store or the user file`: after a QCM flow, raw `oauth.json` and every file in `users/` do not contain `pw`.
- `OWNER_ED_USERNAME creates the owner on a fresh install`: no `session.json`, env `OWNER_ED_USERNAME=Moi` → login `moi` → 302, record `isOwner`.
- `startHttpServer refuses OAuth without multiUser`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/transport/oauth.test.ts` → FAIL.
- [ ] **Step 3: Implement** the provider and pages. In `http.ts`, mount `POST LOGIN_PATH` and `POST TWO_FACTOR_PATH` with `express.urlencoded`, passing `req.ip`. Delete `consentPage.ts` and the passphrase consent code.
- [ ] **Step 4: Run to verify pass** — `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: École Directe login and approval inside the OAuth flow"`

### Task 7: Each MCP request runs as its user

**Files:**
- Modify: `src/transport/http.ts`, `src/transport/downloadLinks.ts`, `src/mcp/tools/downloadDocument.ts`
- Test: `test/transport/multiUser.test.ts` (new), `test/transport/downloadLinks.test.ts`

**Interfaces:**
- Consumes: `MultiUser` (Task 5), `PerUserFake`/`buildMultiUser` (Task 6).
- Produces:
  - In multi-user mode, `/mcp` resolves `userId`:
    - fixed token → `(await users.owner())?.userId`
    - OAuth → `req.auth.extra.userId`, falling back to the owner's id when it is `null` (legacy tokens)
    - then `runtimes.get(userId)`.
  - When no runtime: `oauthStore.revokeUser(userId)` if an id was known, then 401 `{ error: 'invalid_token' }` with header `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<getOAuthProtectedResourceMetadataUrl(resourceUrl)>"`.
  - Otherwise `handleMcp` gets `{ ...context, client: rt.client, sessionBox: rt.sessionBox, config: { ...context.config, downloadDir: join(context.config.downloadDir, userId) }, downloadLinks }`.
  - `purgeOldFiles(dir: string, maxAgeMs: number, now?: () => number): Promise<void>` in `downloadLinks.ts` deletes regular files whose `mtimeMs` is older than `maxAgeMs` and ignores ENOENT. `download_document` calls it on `context.config.downloadDir` with `DEFAULT_DOWNLOAD_LINK_TTL_MS` before downloading, only when `context.downloadLinks` is set.
  - Without OAuth (tailnet only), behaviour is unchanged.

- [ ] **Step 1: Write the failing tests** (`test/transport/multiUser.test.ts`, tokens issued directly with `oauthStore.issueTokens({ clientId: 'c', scopes: ['ecoledirecte:read'], userId }, …)`):
- `user A's token only ever reads A's grades`: approved A and B; `tools/call get_grades` with A's token → JSON contains `"label":"a"` and not `"label":"b"`; the same the other way round.
- `a pending user's token gets 401 with WWW-Authenticate`.
- `a token whose user was removed gets 401 and is revoked`: `removeUser(idB)` then call → 401; `oauthStore.findAccessToken(tB)` undefined.
- `the fixed token and a legacy token without userId act as the owner`.
- `an expired École Directe session revokes the user's tokens and asks to reconnect`: queue `TokenExpiredError` on `getGrades` and `refreshSession` → tool result `isError`, text contains `reconnecte le connecteur`; next call with the same token → 401.
- `downloads land in the user's folder`: `download_document` with A → `fake.lastArgs.downloadDocument[3]` (destinationDir) ends with `/<idA>`.
- `downloadLinks.test.ts`: `purgeOldFiles removes files older than maxAge and keeps fresh ones; missing dir is fine`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/transport` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass** — `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: route each MCP request to its own user's session"`

### Task 8: Admin page

**Files:**
- Create: `src/admin/admin.ts`, `src/admin/adminPages.ts`
- Modify: `src/transport/http.ts` (mount when multi-user)
- Test: `test/admin/admin.test.ts`

**Interfaces:**
- Consumes: `MultiUser`, `renderShell`/`escapeHtml` (Task 6), `RateLimiter`, `hmacHex`.
- Produces: `mountAdmin(app: Express, options: { multiUser: MultiUser; passphrase: string; secureCookie: boolean; now?: () => number }): void`, with these routes:
  - `GET /admin`: login form, or the list when the cookie is valid. Runs `purgeExpiredPending()` first.
  - `POST /admin/login` (`passphrase`): sets the cookie, 303 `/admin`; wrong → 401 + `limiter.hit(ip)`; blocked → 429.
  - `POST /admin/logout`: clears the cookie, 303.
  - `POST /admin/users/:userId/approve` (pending → approved + `approvedAt`), `/reject` (pending only → `removeUser`), `/revoke` (not the owner → `removeUser`). All 303 `/admin`. Unknown id → 303. No valid cookie → 401.
  - Cookie value `<expiresAtMs>.<hmacHex(keys, 'admin:' + expiresAtMs)>`, constant-time compared, expired → invalid.
  - List columns: nom affiché, type de compte, statut (« en attente » / « validé » / « propriétaire »), demandé le, dernière session (`session.updatedAt`), and buttons. The owner row has no revoke button. Banner « Aucun propriétaire : définis OWNER_ED_USERNAME ou importe session.json. » when `owner()` is null. Every user string is passed through `escapeHtml`.

- [ ] **Step 1: Write the failing tests**
- `GET /admin without cookie shows the login form, not the list`.
- `wrong passphrase 401; the 11th failure is 429`.
- `login sets an HttpOnly SameSite=Strict cookie scoped to /admin` (`set-cookie` includes `HttpOnly`, `SameSite=Strict`, `Path=/admin`).
- `actions without a valid or with a forged cookie are 401 and change nothing`.
- `approve turns a pending user into approved`; `reject removes a pending user`; `revoke removes an approved user and their tokens`; `the owner cannot be revoked` (record still there).
- `a display name with HTML is escaped in the list` (`<script>` → `&lt;script&gt;`).
- `the list shows the no-owner banner when there is no owner`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/admin` → FAIL.
- [ ] **Step 3: Implement** — `secureCookie = new URL(publicUrl).protocol === 'https:'`; parse `req.headers.cookie` by hand.
- [ ] **Step 4: Run to verify pass** — `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: admin page to approve, reject and revoke users"`

### Task 9: CLI wiring, health, docs

**Files:**
- Modify: `src/cli/index.ts`, `.env.example`, `docker-compose.yml`, `README.md`
- Test: `test/transport/http.test.ts` (health case)

**Interfaces:**
- Consumes: everything above.
- `runServeCommand(useHttp)` when `config.oauth.enabled`:
  - `multiUser = await createMultiUser(config, base)`.
  - The `SessionMonitor` check resolves the owner runtime on each run (`owner()` → `runtimes.get`), throws `NoSessionError` when absent, then calls `getTimeline`.
  - `context.sessionBox` is the owner runtime's box when present at startup, otherwise an empty box (limit: `/health.sessionExists` stays false until restart if the owner only appears later through `OWNER_ED_USERNAME`; comment it as `shortcut:`).
  - Pass `{ monitor, multiUser }` to `startHttpServer`.
- stdio and HTTP-without-OAuth paths stay untouched.

- [ ] **Step 1: Write the failing test** — `http.test.ts`: `in multi-user mode /health reports the owner session` (owner imported, monitor checked once → `status: 'ok'`, `sessionExists: true`).
- [ ] **Step 2: Run to verify fail** — `npx vitest run test/transport/http.test.ts` → FAIL.
- [ ] **Step 3: Implement** `cli/index.ts`, then the docs:
  - `.env.example` gets `SESSION_ENCRYPTION_KEY`, `NOTIFY_WEBHOOK_URL`, `OWNER_ED_USERNAME` with French comments, and `MCP_OAUTH_PASSPHRASE` rewritten as the admin passphrase.
  - `docker-compose.yml` passes the three new variables through.
  - The README gets a « Multi-utilisateur » section: inviting a friend (send the URL), the approval flow, `/admin`, how to repair a session (reconnect the connector, or `login` + restart for the owner), and backing up `SESSION_ENCRYPTION_KEY` (lost key = every user logs in again).
- [ ] **Step 4: Verify everything**

Run: `npm test && npm run typecheck && npm run build && docker compose build`
Expected: all tests pass, build OK, image builds.

- [ ] **Step 5: Commit** — `git commit -m "feat: wire multi-user mode into serve --http; document it"`

Deployment to the live container (add `SESSION_ENCRYPTION_KEY` to `.env`, recreate) is **not** part of this plan: ask the owner first. The live `.env` must be checked to be a file before recreating, and the owner's current connector keeps working through the legacy-token rule.
