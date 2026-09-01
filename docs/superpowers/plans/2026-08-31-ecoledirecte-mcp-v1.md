# École Directe MCP — V1 (local, stdio) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only MCP server for École Directe (grades, homework,
timetable, school life, class life, timeline, documents) usable from
Claude Code/Desktop over stdio, backed by `@blockshub/blocksdirecte`
behind an internal `EcoleDirecteClient` interface, with a CLI that handles
the mandatory QCM ("double authentification") login flow once.

**Architecture:** A single TypeScript/ESM npm package. `src/client/`
defines our own DTOs and the `EcoleDirecteClient` interface;
`blocksDirecteAdapter.ts` is the only file that touches
`@blockshub/blocksdirecte` types; two decorators
(`errors.ts#withAutoRefresh`, `cachingClient.ts#createCachingClient`) wrap
it for retry-once-on-expiry and TTL-cache/serialization. `src/mcp/`
exposes 9 MCP tools over a stdio transport. `src/cli/` provides `login`
(interactive QCM) and `serve` (stdio only in V1; `--http` errors out,
reserved for V2).

**Tech Stack:** Node.js ≥20, TypeScript 5.9.3 (strict, ESM/NodeNext),
`@modelcontextprotocol/sdk` 1.30.0, `@blockshub/blocksdirecte` 0.0.9-alpha
(exact, no `^`), `zod` 4.5.4, `vitest` 4.1.11, `tsx` 4.23.13 (dev-only, to
run the smoke-test script).

**Spec:** `/home/ubuntu/.claude/plans/je-suis-lyc-en-et-deep-beaver.md`

## Global Constraints

- Pin `@blockshub/blocksdirecte` to the exact version `0.0.9-alpha` in
  `package.json` (no `^`, no `~`) — it's alpha and has already had a
  breaking header rename between patch releases. All other dependency
  versions in this plan are pinned exact too; Task 1 re-verifies every
  pin against the npm registry before installing (versions were last
  confirmed to exist on 2026-08-31).
- No type from `@blockshub/blocksdirecte` may be imported outside
  `src/client/blocksDirecteAdapter.ts` and `src/client/mappers.ts`. Every
  other file (tools, CLI, store, decorators, tests) only sees the DTOs
  and `EcoleDirecteClient` interface defined in `src/client/types.ts`.
- `src/client/blocksDirecteAdapter.ts` must route every BlocksDirecte
  data call through the `wrapCall` helper from `src/client/errors.ts` so
  a raw BlocksDirecte error with a numeric École Directe code becomes a
  typed `EcoleDirecteApiError` — this is what makes
  `withAutoRefresh`'s 520/525 detection reachable at all. A method that
  calls BlocksDirecte without going through `wrapCall` is a bug.
- `session.json` is written atomically (temp file + `rename`), file mode
  `0o600` and parent directory mode `0o700`, both set via the `mode`
  option on the `fs/promises` calls themselves (no separate `chmod`).
  `deviceUUID` lives in its own small file (`device-id`, not inside
  `session.json`) and is persisted **the instant it's generated** —
  before any login attempt — so a failed or aborted login attempt never
  causes a later retry to register as a "new device" with École Directe.
- `EcoleDirecteClient` methods still take a required, non-null `Session`
  (except `getAuthStatus`, which already accepts `Session | null`). The
  MCP server may have **no session at all** (never logged in, or startup
  refresh failed) — `SessionBox.get()` returns `Session | null`, and
  every tool except `get_auth_status` goes through the shared `runTool`
  helper (Task 11), which returns a clear MCP error instead of calling
  the client when there's no session. The stdio transport always starts
  regardless of session state, so `get_auth_status` is never itself
  unreachable.
- On a 520/525 (invalid/expired token) error, retry the call **once**
  after a single `refreshSession()`; concurrent callers share one
  in-flight refresh; a call that already holds a stale session reuses
  whatever fresher session is already in the `SessionBox` instead of
  refreshing again; if refresh also fails, throw
  `AuthenticationRequiredError` telling the user to re-run
  `ecoledirecte-mcp login` — never loop.
- **Session refresh is two complementary mechanisms, not just reactive
  retry** (added after Task 6's review found the mechanism above is
  unreachable for most calls — see Task 4's Amendment and Task 6's
  Amendment below for the full story):
  1. **Preventive** — `withAutoRefresh` proactively refreshes a session
     older than `SESSION_MAX_AGE_MS` (env var, default 15 minutes — a
     conservative guess pending real-world calibration via Task 16)
     before attempting a call, reusing the same in-flight dedup as the
     reactive path. A failed preventive refresh is non-fatal: the call
     proceeds with the session it has, and a genuine problem still
     surfaces via the reactive path below.
  2. **Reactive-structural** — `@blockshub/blocksdirecte`'s data-fetching
     methods (everything except login/refresh/2FA) never throw a typed
     error on an expired token: École Directe's numeric error `code` is
     discarded inside the library before it reaches the adapter, for
     these methods only. So `blocksDirecteAdapter.ts` asserts the raw
     result isn't `null`/`undefined` wherever the library structurally
     guarantees an object or array, throwing `PossiblyExpiredSessionError`
     if it is — treated identically to `TokenExpiredError` by
     `withAutoRefresh` (one refresh, one retry, else
     `AuthenticationRequiredError`, never a loop). A **legitimately
     empty** result (`[]`, `{}`) is never treated as a staleness signal —
     only a missing one.
  3. Anything neither mechanism catches (e.g. `markHomeworkDone`, a write
     call with no return data to inspect) surfaces as a plain, explicit
     error telling the user to re-run `login` — a documented, accepted V1
     limitation (see Task 16's README section), not silently swallowed.
  4. **No fork of `@blockshub/blocksdirecte`** to fix this at the source —
     maintaining a patched copy of an already-alpha dependency was judged
     not worth it for a personal-use V1.
- `messaging.ts` / a `get_messages` tool are explicitly **out of scope for
  this plan** — the spec requires verifying the real request contract
  (against `ecoledirecte-api-docs` and the user's "Mon ÉcoleDirecte"
  Electron app source, not yet available) before writing any code for it.
  See "Deferred / not in this plan" at the end.
- V2 (HTTP transport, Docker, Tailscale) is a separate follow-up plan,
  not covered here. `serve --http` in this plan only needs to fail with a
  clear message.

---

## File Structure

```
package.json
tsconfig.json
tsconfig.test.json             # noEmit, covers src + test + scripts (typecheck script + CI)
.gitignore
.env.example
.github/workflows/ci.yml
README.md
src/
  config.ts
  client/
    types.ts                # our DTOs + EcoleDirecteClient interface
    sessionBox.ts            # SessionBox (Session | null) + createSessionBox
    mappers.ts                # pure BlocksDirecte -> DTO mapping functions + stripHtml
    blocksDirecteAdapter.ts   # only file (besides mappers.ts) that imports @blockshub/blocksdirecte
    errors.ts                 # error classes, mapErrorCode, wrapCall, refresh-once-with-dedupe decorator
    cachingClient.ts           # TTL cache + in-flight dedupe + serialized queue + invalidation
    createClient.ts            # composition root
  store/
    sessionStore.ts            # atomic read/write, dedicated deviceUUID file
  mcp/
    server.ts                  # McpServer + tool registration
    runTool.ts                  # shared no-session-guard + typed-error-to-MCP-error helper
    tools/
      getGrades.ts
      getHomework.ts
      getTimetable.ts
      getSchoolLife.ts
      getClassLife.ts
      getTimeline.ts
      getAuthStatus.ts          # only tool that bypasses runTool (must work with no session)
      markHomeworkDone.ts      # gated by config.readOnly
      downloadDocument.ts
  transport/
    stdio.ts
  cli/
    login.ts                   # runLoginFlow (testable) 
    index.ts                   # process wiring: prompts, argv, entrypoint
test/
  fakes/
    FakeEcoleDirecteClient.ts   # + makeSession()
  fixtures/
    blocksDirecteFixtures.ts    # raw BlocksDirecte-shaped fixture builders
  store/
    sessionStore.test.ts
  client/
    errors.test.ts
    mappers.test.ts
    cachingClient.test.ts
    createClient.test.ts
  config.test.ts
  cli/
    login.test.ts
  mcp/
    runTool.test.ts
    tools.test.ts
scripts/
  smoke-test.ts                 # manual, real account, never in CI
```

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.ts` (placeholder export removed by Task 8; here just enough to prove the toolchain works)

**Interfaces:**
- Produces: a working `npm run build`, `npm run typecheck`, and `npm test`
  toolchain every later task relies on.

- [ ] **Step 1: Re-verify pinned dependency versions**

The exact versions below were confirmed to exist on the npm registry
while writing this plan (2026-08-31). Re-check now, since time has
passed and alpha/fast-moving packages (`@blockshub/blocksdirecte`
especially) can be unpublished or superseded:

Run:
```bash
npm view @modelcontextprotocol/sdk@1.30.0 version
npm view @blockshub/blocksdirecte@0.0.9-alpha version
npm view zod@4.5.4 version
npm view typescript@5.9.3 version
npm view vitest@4.1.11 version
npm view tsx@4.23.13 version
npm view @types/node@26.4.0 version
```

Expected: each command prints its version, no `npm error`. If any pin no
longer resolves, pick the closest still-published patch/version for that
package, use it consistently below, and note the substitution when
reporting this task back.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "ecoledirecte-mcp",
  "version": "0.1.0",
  "description": "Serveur MCP pour École Directe (usage personnel)",
  "type": "module",
  "bin": {
    "ecoledirecte-mcp": "./dist/cli/index.js"
  },
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.test.json",
    "test": "vitest run",
    "smoke-test": "tsx --env-file=.env scripts/smoke-test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@blockshub/blocksdirecte": "0.0.9-alpha",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vitest": "4.1.11",
    "tsx": "4.23.13",
    "@types/node": "26.4.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `tsconfig.test.json`**

This is the config every later task's typecheck step and CI actually
run — `tsconfig.json`'s `include: ["src"]` never touches `test/` or
`scripts/`, so without this, the `Awaited<ReturnType<...>>` types
derived from `@blockshub/blocksdirecte` in tests would silently stop
being checked, which is exactly where a BlocksDirecte version bump would
need to break loudly.

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
.env
*.tsbuildinfo
```

- [ ] **Step 6: Write `.env.example`**

```
# Optionnel, sinon ~/.config/ecoledirecte-mcp/session.json
SESSION_PATH=
# Optionnel, sinon ~/.local/share/ecoledirecte-mcp/downloads
DOWNLOAD_DIR=
# true pour désactiver mark_homework_done (par défaut: false en local)
READ_ONLY=false
```

Note: this file only ever holds non-secret overrides. École Directe
credentials are never stored in `.env` — they're entered interactively
by `ecoledirecte-mcp login` and persisted only in the session file (see
Task 3).

- [ ] **Step 7: Write a minimal `src/config.ts` placeholder**

```typescript
export interface Config {
  sessionPath: string;
  downloadDir: string;
  readOnly: boolean;
}
```

- [ ] **Step 8: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, `package-lock.json` created, no errors.

- [ ] **Step 9: Verify the toolchain**

Run: `npm run build`
Expected: succeeds, creates `dist/config.js`.

Run: `npm run typecheck`
Expected: succeeds (no test files exist yet, so this just confirms the
`tsconfig.test.json` setup itself is valid).

Run: `npm test`
Expected: `vitest` runs with "No test files found" (not an error — no tests written yet).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.test.json .gitignore .env.example src/config.ts
git commit -m "chore: project scaffolding"
```

---

## Task 2: Core DTOs, `EcoleDirecteClient` interface, session box, and fake client

**Files:**
- Create: `src/client/types.ts`
- Create: `src/client/sessionBox.ts`
- Create: `test/fakes/FakeEcoleDirecteClient.ts`
- Test: `test/fakes/FakeEcoleDirecteClient.test.ts`
- Test: `test/client/sessionBox.test.ts`

**Interfaces:**
- Produces: `Session`, `TwoFactorChallenge`, `LoginCredentials`, `Grade`,
  `HomeworkItem` (note: `description`, not `descriptionHtml` — see Task 5
  for why), `TimetableSlot`, `SchoolLifeEntry`, `ClassLifeSummary`,
  `ClassLifeComment`, `TimelineEntry`, `DownloadResult`, `AuthStatus`,
  `EcoleDirecteClient` (all consumed by every later task).
  `SessionBox`, `createSessionBox(initial: Session | null, persist)`
  (consumed by Tasks 4, 9, 11, 12, 13, 14 — `get()` returns
  `Session | null` because the server must be able to start with no
  session at all; see Task 11's `runTool`).
  `FakeEcoleDirecteClient` + `makeSession()` (consumed by Tasks 4, 5, 9,
  10, 11, 12, 13).

- [ ] **Step 1: Write `src/client/types.ts`**

```typescript
export interface Session {
  username: string;
  deviceUUID: string;
  accountId: string;
  accountKind: string;
  displayName: string;
  accessToken: string;
  cnKey?: string;
  cvKey?: string;
  updatedAt: string;
}

export interface TwoFactorChallenge {
  token: string;
  question: string;
  propositions: string[];
}

export interface LoginCredentials {
  username: string;
  password: string;
  deviceUUID: string;
}

export interface Grade {
  id: string;
  subject: string;
  label: string;
  value: number | null;
  scale: number;
  date: string;
  coefficient: number;
  classAverage: number | null;
}

export interface HomeworkItem {
  id: string;
  subject: string;
  dueDate: string;
  description: string;
  done: boolean;
}

export interface TimetableSlot {
  id: string;
  subject: string;
  teacher: string | null;
  room: string | null;
  start: string;
  end: string;
  cancelled: boolean;
}

export interface SchoolLifeEntry {
  id: string;
  type: string;
  date: string;
  description: string;
  justified: boolean | null;
}

export interface ClassLifeComment {
  id: string;
  author: string;
  date: string;
  message: string;
}

export interface ClassLifeSummary {
  className: string;
  content: string;
  updatedAt: string;
  comments: ClassLifeComment[];
}

export interface TimelineEntry {
  id: string;
  date: string;
  type: string;
  summary: string;
}

export interface DownloadResult {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AuthStatus {
  sessionExists: boolean;
  username: string | null;
  lastRefreshAt: string | null;
  lastErrorCode: number | null;
}

export interface EcoleDirecteClient {
  login(credentials: LoginCredentials): Promise<Session | TwoFactorChallenge>;
  completeTwoFactor(
    challenge: TwoFactorChallenge,
    answer: string,
    credentials: LoginCredentials,
  ): Promise<Session>;
  refreshSession(session: Session): Promise<Session>;
  getGrades(session: Session, schoolYear?: string): Promise<Grade[]>;
  getHomework(session: Session, fromDate: string, toDate: string): Promise<HomeworkItem[]>;
  markHomeworkDone(session: Session, homeworkId: string, done: boolean): Promise<void>;
  getTimetable(session: Session, fromDate: string, toDate: string): Promise<TimetableSlot[]>;
  getSchoolLife(session: Session): Promise<SchoolLifeEntry[]>;
  getClassLife(session: Session): Promise<ClassLifeSummary>;
  getTimeline(session: Session): Promise<TimelineEntry[]>;
  downloadDocument(
    session: Session,
    fileId: string,
    fileType: string,
    destinationDir: string,
  ): Promise<DownloadResult>;
  getAuthStatus(session: Session | null): Promise<AuthStatus>;
}
```

- [ ] **Step 2: Write the failing test for the fake**

```typescript
// test/fakes/FakeEcoleDirecteClient.test.ts
import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from './FakeEcoleDirecteClient.js';

describe('FakeEcoleDirecteClient', () => {
  it('returns configured fixtures and counts calls', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.grades = [
      { id: '1', subject: 'Maths', label: 'DS', value: 15, scale: 20, date: '2026-01-01', coefficient: 1, classAverage: 10 },
    ];
    const session = makeSession();

    const grades = await fake.getGrades(session);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.getGrades).toBe(1);
  });

  it('throws a queued failure once, then succeeds', async () => {
    const fake = new FakeEcoleDirecteClient();
    const session = makeSession();
    fake.queueFailure('getGrades', new Error('boom'));

    await expect(fake.getGrades(session)).rejects.toThrow('boom');
    await expect(fake.getGrades(session)).resolves.toEqual(fake.grades);
    expect(fake.callCounts.getGrades).toBe(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/fakes/FakeEcoleDirecteClient.test.ts`
Expected: FAIL — `Cannot find module './FakeEcoleDirecteClient.js'`.

- [ ] **Step 4: Write `test/fakes/FakeEcoleDirecteClient.ts`**

```typescript
import type {
  AuthStatus,
  ClassLifeSummary,
  DownloadResult,
  EcoleDirecteClient,
  Grade,
  HomeworkItem,
  LoginCredentials,
  SchoolLifeEntry,
  Session,
  TimelineEntry,
  TimetableSlot,
  TwoFactorChallenge,
} from '../../src/client/types.js';

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    username: 'jdupont',
    deviceUUID: 'device-uuid-1',
    accountId: '12345',
    accountKind: 'E',
    displayName: 'Jean Dupont',
    accessToken: 'fake-access-token',
    cnKey: undefined,
    cvKey: undefined,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type MethodName = keyof EcoleDirecteClient;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeEcoleDirecteClient implements EcoleDirecteClient {
  session: Session = makeSession();
  twoFactorChallenge: TwoFactorChallenge | null = null;
  refreshedSession: Session | null = null;
  grades: Grade[] = [];
  homework: HomeworkItem[] = [];
  timetable: TimetableSlot[] = [];
  schoolLife: SchoolLifeEntry[] = [];
  classLife: ClassLifeSummary = { className: '', content: '', updatedAt: '', comments: [] };
  timeline: TimelineEntry[] = [];
  downloadResult: DownloadResult = { path: '', filename: '', mimeType: '', sizeBytes: 0 };
  callDelayMs = 0;

  callCounts: Partial<Record<MethodName, number>> = {};
  globalInFlight = 0;
  globalMaxConcurrent = 0;
  private failQueues: Partial<Record<MethodName, Error[]>> = {};

  queueFailure(method: MethodName, error: Error): void {
    (this.failQueues[method] ??= []).push(error);
  }

  private async record<T>(method: MethodName, fn: () => T | Promise<T>): Promise<T> {
    this.callCounts[method] = (this.callCounts[method] ?? 0) + 1;
    this.globalInFlight += 1;
    this.globalMaxConcurrent = Math.max(this.globalMaxConcurrent, this.globalInFlight);
    try {
      if (this.callDelayMs > 0) await sleep(this.callDelayMs);
      const queue = this.failQueues[method];
      if (queue && queue.length > 0) {
        throw queue.shift() as Error;
      }
      return await fn();
    } finally {
      this.globalInFlight -= 1;
    }
  }

  login(_credentials: LoginCredentials): Promise<Session | TwoFactorChallenge> {
    return this.record('login', () => this.twoFactorChallenge ?? this.session);
  }

  completeTwoFactor(
    _challenge: TwoFactorChallenge,
    _answer: string,
    _credentials: LoginCredentials,
  ): Promise<Session> {
    return this.record('completeTwoFactor', () => this.session);
  }

  refreshSession(session: Session): Promise<Session> {
    return this.record('refreshSession', () => this.refreshedSession ?? session);
  }

  getGrades(_session: Session, _schoolYear?: string): Promise<Grade[]> {
    return this.record('getGrades', () => this.grades);
  }

  getHomework(_session: Session, _fromDate: string, _toDate: string): Promise<HomeworkItem[]> {
    return this.record('getHomework', () => this.homework);
  }

  markHomeworkDone(_session: Session, _homeworkId: string, _done: boolean): Promise<void> {
    return this.record('markHomeworkDone', () => undefined);
  }

  getTimetable(_session: Session, _fromDate: string, _toDate: string): Promise<TimetableSlot[]> {
    return this.record('getTimetable', () => this.timetable);
  }

  getSchoolLife(_session: Session): Promise<SchoolLifeEntry[]> {
    return this.record('getSchoolLife', () => this.schoolLife);
  }

  getClassLife(_session: Session): Promise<ClassLifeSummary> {
    return this.record('getClassLife', () => this.classLife);
  }

  getTimeline(_session: Session): Promise<TimelineEntry[]> {
    return this.record('getTimeline', () => this.timeline);
  }

  downloadDocument(
    _session: Session,
    _fileId: string,
    _fileType: string,
    _destinationDir: string,
  ): Promise<DownloadResult> {
    return this.record('downloadDocument', () => this.downloadResult);
  }

  getAuthStatus(session: Session | null): Promise<AuthStatus> {
    return this.record('getAuthStatus', () => ({
      sessionExists: session !== null,
      username: session?.username ?? null,
      lastRefreshAt: session?.updatedAt ?? null,
      lastErrorCode: null,
    }));
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/fakes/FakeEcoleDirecteClient.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the failing test for `sessionBox`**

```typescript
// test/client/sessionBox.test.ts
import { describe, expect, it } from 'vitest';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

describe('createSessionBox', () => {
  it('returns the initial session (or null) via get()', () => {
    expect(createSessionBox(null, async () => {}).get()).toBeNull();
    const session = makeSession();
    expect(createSessionBox(session, async () => {}).get()).toEqual(session);
  });

  it('updates the in-memory value and calls persist on set()', async () => {
    const persisted: unknown[] = [];
    const box = createSessionBox(null, async (session) => { persisted.push(session); });
    const session = makeSession();

    await box.set(session);

    expect(box.get()).toEqual(session);
    expect(persisted).toEqual([session]);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/client/sessionBox.test.ts`
Expected: FAIL — `Cannot find module '../../src/client/sessionBox.js'`.

- [ ] **Step 8: Write `src/client/sessionBox.ts`**

```typescript
import type { Session } from './types.js';

export interface SessionBox {
  get(): Session | null;
  set(session: Session): Promise<void>;
}

export function createSessionBox(
  initial: Session | null,
  persist: (session: Session) => Promise<void>,
): SessionBox {
  let current = initial;
  return {
    get: () => current,
    set: async (session) => {
      current = session;
      await persist(session);
    },
  };
}
```

Why `Session | null`: `EcoleDirecteClient` methods still require a real
`Session` (they're called from `SessionBox` state that the tool layer has
already checked — see Task 11's `runTool`), but the box itself must be
able to hold "no session yet" so the MCP server can start even when the
user hasn't logged in, or when a startup refresh fails (see Task 14).

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/client/sessionBox.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add src/client/types.ts src/client/sessionBox.ts test/fakes/FakeEcoleDirecteClient.ts test/fakes/FakeEcoleDirecteClient.test.ts test/client/sessionBox.test.ts
git commit -m "feat: core DTOs, EcoleDirecteClient interface, session box, fake client"
```

---

## Task 3: Atomic session store + deviceUUID persistence

**Context for the implementer:** `deviceUUID` must be stable across
repeated login attempts from the same machine — École Directe treats a
new `deviceUUID` as a "new device" and forces the QCM again. It must
therefore be persisted **the instant it's generated**, in its own small
file (`device-id`), completely separate from `session.json` (which is
only written after a full successful login). Otherwise: a login attempt
that reaches the QCM step but then fails or is aborted (wrong answer,
Ctrl-C, bad password) never writes `session.json`, so a retry would
regenerate a fresh `deviceUUID` and get a fresh, unnecessary QCM again
even though it's the same physical machine.

**Files:**
- Create: `src/store/sessionStore.ts`
- Test: `test/store/sessionStore.test.ts`

**Interfaces:**
- Consumes: `Session` from `src/client/types.ts` (Task 2).
- Produces: `resolveSessionPath(): string`, `defaultDeviceIdPath(): string`,
  `readSession(path?): Promise<Session | null>`,
  `writeSession(session, path?): Promise<void>`,
  `loadOrCreateDeviceUUID(path?): Promise<string>` — consumed by Tasks 9, 10, 14, 16.

- [ ] **Step 1: Write the failing test**

```typescript
// test/store/sessionStore.test.ts
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateDeviceUUID, readSession, writeSession } from '../../src/store/sessionStore.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

describe('sessionStore', () => {
  let dir: string;
  let sessionPath: string;
  let deviceIdPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ecoledirecte-mcp-test-'));
    sessionPath = join(dir, 'nested', 'session.json');
    deviceIdPath = join(dir, 'nested', 'device-id');
  });

  it('writes and reads back a session, creating parent directories', async () => {
    const session = makeSession();
    await writeSession(session, sessionPath);

    const read = await readSession(sessionPath);

    expect(read).toEqual(session);
  });

  it('returns null when no session file exists', async () => {
    expect(await readSession(sessionPath)).toBeNull();
  });

  it('writes the session file with 0o600, the parent dir with 0o700, and leaves no temp file behind', async () => {
    await writeSession(makeSession(), sessionPath);

    const fileStats = await stat(sessionPath);
    expect(fileStats.mode & 0o777).toBe(0o600);

    const dirStats = await stat(join(dir, 'nested'));
    expect(dirStats.mode & 0o777).toBe(0o700);

    const entries = await readdir(join(dir, 'nested'));
    expect(entries.sort()).toEqual(['session.json']);
  });

  it('generates a deviceUUID once and persists it immediately, before any session exists', async () => {
    const uuid = await loadOrCreateDeviceUUID(deviceIdPath);
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);

    const persisted = (await readFile(deviceIdPath, 'utf8')).trim();
    expect(persisted).toBe(uuid);
  });

  it('reuses the persisted deviceUUID on subsequent calls instead of generating a new one', async () => {
    const first = await loadOrCreateDeviceUUID(deviceIdPath);
    const second = await loadOrCreateDeviceUUID(deviceIdPath);
    expect(second).toBe(first);
  });

  afterEach(async () => {
    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/store/sessionStore.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/sessionStore.js'`.

- [ ] **Step 3: Write `src/store/sessionStore.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session } from '../client/types.js';

export function defaultSessionPath(): string {
  return join(homedir(), '.config', 'ecoledirecte-mcp', 'session.json');
}

export function defaultDeviceIdPath(): string {
  return join(homedir(), '.config', 'ecoledirecte-mcp', 'device-id');
}

export function resolveSessionPath(): string {
  return process.env.SESSION_PATH ?? defaultSessionPath();
}

export async function readSession(path: string = resolveSessionPath()): Promise<Session | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeSession(session: Session, path: string = resolveSessionPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, path);
}

export async function loadOrCreateDeviceUUID(path: string = defaultDeviceIdPath()): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const uuid = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, uuid, { encoding: 'utf8', mode: 0o600 });
  return uuid;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/store/sessionStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/sessionStore.ts test/store/sessionStore.test.ts
git commit -m "feat: atomic session store with dedicated deviceUUID persistence"
```

---

## Task 4: Error mapping, `wrapCall`, and refresh-once-with-dedupe decorator

**Context for the implementer:** the adapter (Task 6) will call this
task's `wrapCall` around every BlocksDirecte data call so a raw
BlocksDirecte error becomes one of the typed errors below — without
that, `withAutoRefresh` never sees a `TokenExpiredError` and its retry
logic is unreachable in production. Exactly how BlocksDirecte surfaces
École Directe's numeric error code on a failed data call isn't
documented in its `.d.ts` (only the three login-related error classes —
`Require2FA`, `InvalidCredentials`, `Invalid2FAKey` — are); `extractErrorCode`
therefore **duck-types** a thrown value defensively for a numeric `code`
(top level, or under `.response.code` — chosen only because
`ServerResponse<T>`'s *success* shape in the `.d.ts` uses a `code` field,
not because we know the failure shape actually matches it). No type from
`@blockshub/blocksdirecte` is imported to do this — it operates on
`unknown`. A value that doesn't match returns `undefined`, and `wrapCall`
rethrows it completely unchanged rather than fabricating an
`EcoleDirecteApiError` (tested explicitly below). **This heuristic is unverified
against a real expired token** — Task 16's smoke test includes a step
to confirm it against the user's real account and adjust
`extractErrorCode` if the real shape differs.

**Files:**
- Create: `src/client/errors.ts`
- Test: `test/client/errors.test.ts`

**Interfaces:**
- Consumes: `EcoleDirecteClient`, `Session`, `SessionBox`, `createSessionBox`
  (Task 2); `FakeEcoleDirecteClient`, `makeSession` (Task 2).
- Produces: `EcoleDirecteApiError`, `InvalidCredentialsError`, `TokenExpiredError`,
  `SchoolUnavailableError`, `InvalidTwoFactorAnswerError`, `AuthenticationRequiredError`,
  `mapErrorCode(code, message)`, `extractErrorCode(error)`, `mapCaughtError(error)`,
  `wrapCall(fn)`, `withAutoRefresh(client, sessionBox)` — consumed by Tasks 6, 9, 11.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/client/errors.test.ts
import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import {
  AuthenticationRequiredError,
  TokenExpiredError,
  wrapCall,
  withAutoRefresh,
} from '../../src/client/errors.js';

describe('wrapCall', () => {
  it('maps a simulated error carrying a numeric code to a typed EcoleDirecteApiError', async () => {
    const error = Object.assign(new Error('token invalide'), { code: 520 });
    await expect(wrapCall(async () => { throw error; })).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('rethrows an error with no discoverable numeric code unchanged', async () => {
    const error = new Error('network down');
    await expect(wrapCall(async () => { throw error; })).rejects.toBe(error);
  });

  it('resolves normally when the wrapped call succeeds', async () => {
    await expect(wrapCall(async () => 42)).resolves.toBe(42);
  });
});

describe('withAutoRefresh', () => {
  it('passes through successful calls without refreshing', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.grades = [{ id: '1', subject: 'Maths', label: 'DS', value: 15, scale: 20, date: '2026-01-01', coefficient: 1, classAverage: 10 }];
    const box = createSessionBox(makeSession(), async () => {});
    const client = withAutoRefresh(fake, box);

    const grades = await client.getGrades(box.get()!);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBeUndefined();
  });

  it('refreshes once and retries after a TokenExpiredError, then persists the new session', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.refreshedSession = makeSession({ accessToken: 'new-token' });
    const persisted: string[] = [];
    const box = createSessionBox(makeSession(), async (session) => { persisted.push(session.accessToken); });
    const client = withAutoRefresh(fake, box);

    const grades = await client.getGrades(box.get()!);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBe(1);
    expect(fake.callCounts.getGrades).toBe(2);
    expect(persisted).toEqual(['new-token']);
    expect(box.get()!.accessToken).toBe('new-token');
  });

  it('throws AuthenticationRequiredError without looping when refresh also fails', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.queueFailure('refreshSession', new Error('refresh failed'));
    const box = createSessionBox(makeSession(), async () => {});
    const client = withAutoRefresh(fake, box);

    await expect(client.getGrades(box.get()!)).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(fake.callCounts.getGrades).toBe(1);
    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('deduplicates concurrent refreshes triggered by parallel calls', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.queueFailure('getHomework', new TokenExpiredError(525, 'expired'));
    fake.refreshedSession = makeSession({ accessToken: 'new-token' });
    const box = createSessionBox(makeSession(), async () => {});
    const client = withAutoRefresh(fake, box);

    await Promise.all([
      client.getGrades(box.get()!),
      client.getHomework(box.get()!, '2026-01-01', '2026-01-31'),
    ]);

    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('reuses an already-fresher session from the box instead of refreshing again', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ accessToken: 'stale-token' });
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    const box = createSessionBox(makeSession({ accessToken: 'fresh-token' }), async () => {});
    const client = withAutoRefresh(fake, box);

    const grades = await client.getGrades(staleSession);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/client/errors.test.ts`
Expected: FAIL — `Cannot find module '../../src/client/errors.js'`.

- [ ] **Step 3: Write `src/client/errors.ts`**

```typescript
import type { SessionBox } from './sessionBox.js';
import type { EcoleDirecteClient, Session } from './types.js';

export class EcoleDirecteApiError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'EcoleDirecteApiError';
    this.code = code;
  }
}

export class InvalidCredentialsError extends EcoleDirecteApiError {}
export class TokenExpiredError extends EcoleDirecteApiError {}
export class SchoolUnavailableError extends EcoleDirecteApiError {}
export class InvalidTwoFactorAnswerError extends EcoleDirecteApiError {}

export class AuthenticationRequiredError extends Error {
  constructor(
    message = "École Directe session expired and could not be refreshed automatically. Run `ecoledirecte-mcp login` again.",
  ) {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

export function mapErrorCode(code: number, message: string): EcoleDirecteApiError {
  switch (code) {
    case 505:
      return new InvalidCredentialsError(code, message);
    case 520:
    case 525:
      return new TokenExpiredError(code, message);
    case 535:
      return new SchoolUnavailableError(code, message);
    default:
      return new EcoleDirecteApiError(code, message);
  }
}

/**
 * Duck-types a thrown value for a numeric error code — this file has no
 * import from @blockshub/blocksdirecte and does not know the real shape
 * of what a failed data call throws (unlike ServerResponse<T>, which is
 * a *success*-path type seen in the library's .d.ts and isn't otherwise
 * relevant here). This is a guess at a plausible shape, unverified
 * against a real expired token — see Task 16. A value that doesn't match
 * (no numeric `.code` or `.response.code`) returns `undefined`, so
 * `wrapCall` rethrows it completely unchanged rather than fabricating an
 * `EcoleDirecteApiError` — see the "rethrows ... unchanged" test above.
 */
export function extractErrorCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const withCode = error as { code?: unknown; response?: { code?: unknown } };
    if (typeof withCode.code === 'number') return withCode.code;
    if (typeof withCode.response?.code === 'number') return withCode.response.code;
  }
  return undefined;
}

export function mapCaughtError(error: unknown): unknown {
  const code = extractErrorCode(error);
  if (code === undefined) return error;
  return mapErrorCode(code, error instanceof Error ? error.message : String(error));
}

export async function wrapCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapCaughtError(error);
  }
}

export function withAutoRefresh(client: EcoleDirecteClient, sessionBox: SessionBox): EcoleDirecteClient {
  let inFlightRefresh: Promise<Session> | null = null;

  async function refreshOnce(staleSession: Session): Promise<Session> {
    const current = sessionBox.get();
    if (current && current.accessToken !== staleSession.accessToken) {
      return current;
    }
    if (!inFlightRefresh) {
      inFlightRefresh = client.refreshSession(staleSession).finally(() => {
        inFlightRefresh = null;
      });
    }
    const refreshed = await inFlightRefresh;
    await sessionBox.set(refreshed);
    return refreshed;
  }

  async function withRetry<T>(session: Session, fn: (session: Session) => Promise<T>): Promise<T> {
    try {
      return await fn(session);
    } catch (error) {
      if (!(error instanceof TokenExpiredError)) throw error;
      let refreshed: Session;
      try {
        refreshed = await refreshOnce(session);
      } catch {
        throw new AuthenticationRequiredError();
      }
      try {
        return await fn(refreshed);
      } catch (retryError) {
        if (retryError instanceof TokenExpiredError) throw new AuthenticationRequiredError();
        throw retryError;
      }
    }
  }

  return {
    login: (credentials) => client.login(credentials),
    completeTwoFactor: (challenge, answer, credentials) => client.completeTwoFactor(challenge, answer, credentials),
    refreshSession: (session) => client.refreshSession(session),
    getGrades: (session, schoolYear) => withRetry(session, (s) => client.getGrades(s, schoolYear)),
    getHomework: (session, fromDate, toDate) => withRetry(session, (s) => client.getHomework(s, fromDate, toDate)),
    markHomeworkDone: (session, homeworkId, done) => withRetry(session, (s) => client.markHomeworkDone(s, homeworkId, done)),
    getTimetable: (session, fromDate, toDate) => withRetry(session, (s) => client.getTimetable(s, fromDate, toDate)),
    getSchoolLife: (session) => withRetry(session, (s) => client.getSchoolLife(s)),
    getClassLife: (session) => withRetry(session, (s) => client.getClassLife(s)),
    getTimeline: (session) => withRetry(session, (s) => client.getTimeline(s)),
    downloadDocument: (session, fileId, fileType, destinationDir) =>
      withRetry(session, (s) => client.downloadDocument(s, fileId, fileType, destinationDir)),
    getAuthStatus: (session) =>
      session ? withRetry(session, (s) => client.getAuthStatus(s)) : client.getAuthStatus(session),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/client/errors.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/client/errors.ts test/client/errors.test.ts
git commit -m "feat: error mapping, wrapCall, and refresh-once retry decorator"
```

---

### Amendment: preventive refresh + `PossiblyExpiredSessionError` (added after Task 6's review)

**Why this exists:** Task 6's review traced the actual compiled
`@blockshub/blocksdirecte` runtime and found that `AuthModules`
(login/refresh/2FA) is the *only* part of the library that inspects
École Directe's numeric `code` field — every data-fetching method
(`getMark`, `getUpcomingHomework`, `getHomeworksForDate`,
`getTimetableBetweenDates`, `getSchoolLife`, `getClassLife`,
`getPersonalTimeline`) does `return (await this.restManager.post(...)).data`
with no check at all, and `code`/`message` are discarded before ever
reaching the adapter — confirmed by reading the library's source
directly, not inferred. So on an expired token, these methods don't
throw — they silently return `null`/`undefined` where a real response
would have been an object or array. The original `wrapCall` design
(Global Constraints, above) can only convert *thrown* errors carrying a
numeric code; it has nothing to catch here. Two mechanisms replace the
single reactive one:

1. **Preventive, age-based refresh** — added to `withAutoRefresh` itself,
   below.
2. **A new typed error, `PossiblyExpiredSessionError`**, thrown by the
   adapter (Task 6's Amendment) when a data call's raw result is
   `null`/`undefined` where the library structurally guarantees an
   object or array — treated identically to `TokenExpiredError` here.

- [ ] **Step 6: Modify the existing tests in `test/client/errors.test.ts`**

Add `PossiblyExpiredSessionError` and `createSessionBox` (if not already
imported — check first) to the existing import from
`'../../src/client/errors.js'` and `'../../src/client/sessionBox.js'`
respectively. Then, in every one of the 5 existing `describe('withAutoRefresh', ...)`
tests, change the construction line from:

```typescript
const client = withAutoRefresh(fake, box);
```

to:

```typescript
const client = withAutoRefresh(fake, box, { maxAgeMs: Number.POSITIVE_INFINITY });
```

This opts every existing test out of the new preventive-refresh behavior
(so they keep testing reactive-only behavior, unchanged in intent) —
without this change, `makeSession()`'s fixed `updatedAt` of
`2026-01-01T00:00:00.000Z` would already be "stale" relative to the real
current clock, breaking every one of these tests' assertions.

- [ ] **Step 7: Append new failing tests to `test/client/errors.test.ts`**

```typescript
describe('withAutoRefresh — preventive age-based refresh', () => {
  it('proactively refreshes a session older than maxAgeMs before calling fn', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.refreshedSession = makeSession({ accessToken: 'new-token', updatedAt: '2026-01-01T00:10:00.000Z' });
    const box = createSessionBox(staleSession, async () => {});
    const now = () => new Date('2026-01-01T00:30:00.000Z').getTime();
    const client = withAutoRefresh(fake, box, { maxAgeMs: 15 * 60 * 1000, now });

    await client.getGrades(staleSession);

    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('does not proactively refresh a session younger than maxAgeMs', async () => {
    const fake = new FakeEcoleDirecteClient();
    const freshSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const box = createSessionBox(freshSession, async () => {});
    const now = () => new Date('2026-01-01T00:05:00.000Z').getTime();
    const client = withAutoRefresh(fake, box, { maxAgeMs: 15 * 60 * 1000, now });

    await client.getGrades(freshSession);

    expect(fake.callCounts.refreshSession).toBeUndefined();
  });

  it('proceeds with the call when a preventive refresh fails, instead of aborting', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.queueFailure('refreshSession', new Error('network blip'));
    const box = createSessionBox(staleSession, async () => {});
    const now = () => new Date('2026-01-01T00:30:00.000Z').getTime();
    const client = withAutoRefresh(fake, box, { maxAgeMs: 15 * 60 * 1000, now });

    const grades = await client.getGrades(staleSession);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('never refreshes for getAuthStatus, even with a stale session', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const box = createSessionBox(staleSession, async () => {});
    const now = () => new Date('2026-01-01T00:30:00.000Z').getTime();
    const client = withAutoRefresh(fake, box, { maxAgeMs: 15 * 60 * 1000, now });

    await client.getAuthStatus(staleSession);

    expect(fake.callCounts.refreshSession).toBeUndefined();
  });
});

describe('withAutoRefresh — PossiblyExpiredSessionError', () => {
  it('treats PossiblyExpiredSessionError the same as TokenExpiredError for reactive retry', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new PossiblyExpiredSessionError());
    fake.refreshedSession = makeSession({ accessToken: 'new-token' });
    const box = createSessionBox(makeSession(), async () => {});
    const client = withAutoRefresh(fake, box, { maxAgeMs: Number.POSITIVE_INFINITY });

    const grades = await client.getGrades(box.get()!);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBe(1);
  });
});

describe('wrapCall — already-typed errors', () => {
  it('does not re-map an already-typed EcoleDirecteApiError — instanceof identity survives', async () => {
    await expect(
      wrapCall(async () => {
        throw new PossiblyExpiredSessionError();
      }),
    ).rejects.toBeInstanceOf(PossiblyExpiredSessionError);
  });
});
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `npx vitest run test/client/errors.test.ts`
Expected: FAIL — `PossiblyExpiredSessionError`/new `withAutoRefresh`
options are not exported/supported yet.

- [ ] **Step 9: Replace the entire contents of `src/client/errors.ts`**

```typescript
import type { SessionBox } from './sessionBox.js';
import type { EcoleDirecteClient, Session } from './types.js';

export class EcoleDirecteApiError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'EcoleDirecteApiError';
    this.code = code;
  }
}

export class InvalidCredentialsError extends EcoleDirecteApiError {}
export class TokenExpiredError extends EcoleDirecteApiError {}
export class SchoolUnavailableError extends EcoleDirecteApiError {}
export class InvalidTwoFactorAnswerError extends EcoleDirecteApiError {}

/**
 * Thrown by the adapter (Task 6) when a BlocksDirecte data method returns
 * null/undefined where it structurally guarantees an object or array — the
 * one observable symptom of an expired token for those methods, since
 * @blockshub/blocksdirecte discards École Directe's numeric error code
 * before it reaches the adapter for anything other than login/refresh/2FA.
 * Treated identically to TokenExpiredError by withAutoRefresh. Do not
 * remove this as "unreachable defensive code" — it is the only signal
 * available for 8 of the 9 data methods. See the plan's Global Constraints
 * for the full rationale.
 */
export class PossiblyExpiredSessionError extends EcoleDirecteApiError {
  constructor(
    message = "École Directe a renvoyé une réponse vide là où un objet ou un tableau était attendu — signe probable d'une session expirée (la librairie ne remonte pas le code d'erreur École Directe pour cet appel).",
  ) {
    super(0, message);
    this.name = 'PossiblyExpiredSessionError';
  }
}

export class AuthenticationRequiredError extends Error {
  constructor(
    message = "École Directe session expired and could not be refreshed automatically. Run `ecoledirecte-mcp login` again.",
  ) {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

export function mapErrorCode(code: number, message: string): EcoleDirecteApiError {
  switch (code) {
    case 505:
      return new InvalidCredentialsError(code, message);
    case 520:
    case 525:
      return new TokenExpiredError(code, message);
    case 535:
      return new SchoolUnavailableError(code, message);
    default:
      return new EcoleDirecteApiError(code, message);
  }
}

/**
 * Duck-types a thrown value for a numeric error code — this file has no
 * import from @blockshub/blocksdirecte and does not know the real shape
 * of what a failed data call throws (unlike ServerResponse<T>, which is
 * a *success*-path type seen in the library's .d.ts and isn't otherwise
 * relevant here). This is a guess at a plausible shape, unverified
 * against a real expired token — see Task 16. A value that doesn't match
 * (no numeric `.code` or `.response.code`) returns `undefined`, so
 * `wrapCall` rethrows it completely unchanged rather than fabricating an
 * `EcoleDirecteApiError`.
 */
export function extractErrorCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const withCode = error as { code?: unknown; response?: { code?: unknown } };
    if (typeof withCode.code === 'number') return withCode.code;
    if (typeof withCode.response?.code === 'number') return withCode.response.code;
  }
  return undefined;
}

export function mapCaughtError(error: unknown): unknown {
  // Already a typed error we (or the adapter) constructed on purpose — never
  // re-map it through the numeric-code heuristic below, which would strip
  // its specific identity (e.g. PossiblyExpiredSessionError has code 0, a
  // sentinel, and would otherwise collapse into a generic EcoleDirecteApiError).
  if (error instanceof EcoleDirecteApiError || error instanceof AuthenticationRequiredError) return error;
  const code = extractErrorCode(error);
  if (code === undefined) return error;
  return mapErrorCode(code, error instanceof Error ? error.message : String(error));
}

export async function wrapCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapCaughtError(error);
  }
}

export interface WithAutoRefreshOptions {
  /** How old (ms) a session may get before a call proactively refreshes it first. Default 15 minutes — a conservative guess, see Task 16. */
  maxAgeMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export function withAutoRefresh(
  client: EcoleDirecteClient,
  sessionBox: SessionBox,
  options: WithAutoRefreshOptions = {},
): EcoleDirecteClient {
  const maxAgeMs = options.maxAgeMs ?? 15 * 60 * 1000;
  const now = options.now ?? Date.now;
  let inFlightRefresh: Promise<Session> | null = null;

  function isStale(session: Session): boolean {
    return now() - new Date(session.updatedAt).getTime() > maxAgeMs;
  }

  function isRetriableError(error: unknown): boolean {
    return error instanceof TokenExpiredError || error instanceof PossiblyExpiredSessionError;
  }

  async function refreshOnce(staleSession: Session): Promise<Session> {
    const current = sessionBox.get();
    if (current && current.accessToken !== staleSession.accessToken) {
      return current;
    }
    if (!inFlightRefresh) {
      inFlightRefresh = client
        .refreshSession(staleSession)
        .then(async (refreshed) => {
          await sessionBox.set(refreshed);
          return refreshed;
        })
        .finally(() => {
          inFlightRefresh = null;
        });
    }
    return inFlightRefresh;
  }

  async function withRetry<T>(session: Session, fn: (session: Session) => Promise<T>): Promise<T> {
    let currentSession = session;
    if (isStale(currentSession)) {
      try {
        currentSession = await refreshOnce(currentSession);
      } catch {
        // Best-effort: a failed preventive refresh doesn't abort the call —
        // proceed with the session we have. A genuine problem still surfaces
        // via the reactive path below.
      }
    }
    try {
      return await fn(currentSession);
    } catch (error) {
      if (!isRetriableError(error)) throw error;
      let refreshed: Session;
      try {
        refreshed = await refreshOnce(currentSession);
      } catch {
        throw new AuthenticationRequiredError();
      }
      try {
        return await fn(refreshed);
      } catch (retryError) {
        if (isRetriableError(retryError)) throw new AuthenticationRequiredError();
        throw retryError;
      }
    }
  }

  return {
    login: (credentials) => client.login(credentials),
    completeTwoFactor: (challenge, answer, credentials) => client.completeTwoFactor(challenge, answer, credentials),
    refreshSession: (session) => client.refreshSession(session),
    getGrades: (session, schoolYear) => withRetry(session, (s) => client.getGrades(s, schoolYear)),
    getHomework: (session, fromDate, toDate) => withRetry(session, (s) => client.getHomework(s, fromDate, toDate)),
    markHomeworkDone: (session, homeworkId, done) => withRetry(session, (s) => client.markHomeworkDone(s, homeworkId, done)),
    getTimetable: (session, fromDate, toDate) => withRetry(session, (s) => client.getTimetable(s, fromDate, toDate)),
    getSchoolLife: (session) => withRetry(session, (s) => client.getSchoolLife(s)),
    getClassLife: (session) => withRetry(session, (s) => client.getClassLife(s)),
    getTimeline: (session) => withRetry(session, (s) => client.getTimeline(s)),
    downloadDocument: (session, fileId, fileType, destinationDir) =>
      withRetry(session, (s) => client.downloadDocument(s, fileId, fileType, destinationDir)),
    // getAuthStatus never touches the network (Task 6's adapter only reads
    // local session fields for it), so it can never throw a retriable error.
    // Wrapping it in withRetry would only add a pointless proactive-refresh
    // side effect to what's meant to be a safe, always-available diagnostic
    // call — the one tool that must work even when the session is bad.
    getAuthStatus: (session) => client.getAuthStatus(session),
  };
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run test/client/errors.test.ts`
Expected: PASS (14 tests: 4 `wrapCall` + 5 original `withAutoRefresh` +
4 preventive-refresh + 1 `PossiblyExpiredSessionError` reactive).

Run: `npm test` (full suite) — confirm nothing in Tasks 1-5 regressed.

- [ ] **Step 11: Commit**

```bash
git add src/client/errors.ts test/client/errors.test.ts
git commit -m "feat: preventive age-based refresh and PossiblyExpiredSessionError"
```

---

### Amendment 2: two confirmed upstream bugs in `@blockshub/blocksdirecte@0.0.9-alpha` (found after Task 14, via real manual testing)

**Context:** after a real login (Task 14's manual step), every tool call
failed with `The accounts list is empty. Make sure you're logged in.`
The user root-caused this down to `refreshCredential`'s call to
`client.auth.refreshToken`, confirmed live against a real, minutes-old
token. Reading the compiled bundle
(`node_modules/@blockshub/blocksdirecte/dist/index.js`, reformatted with
`prettier --parser babel` for readability) confirmed two distinct,
independent bugs — the second found only by tracing what happens *after*
a hypothetical successful refresh:

**Bug 1 — `refreshToken` silently swallows session-expired errors.**
`AuthModules.prototype.refreshToken`'s response handling only branches on
codes `250` (2FA) and `505` (bad creds); every other code — including
whatever École Directe returns for an expired/invalid reLogin attempt —
falls into the `default:` branch, which is the *success* path. It blindly
does `Object.assign(this.credentials, { token: n.token, accounts:
n.data.accounts })` and returns `{ ...n.data, token: n.token }` even when
the real response was an error with `accounts: []` and `token: ''`.
Nothing downstream can tell this apart from a real success.

**Bug 2 — `isModuleAvailableForSelectedAccount` recurses infinitely.**
Independent of Bug 1, and far more severe: this method (defined once on
the shared, unexported `Modules` base class that `marks`/`homework`/
`timetable`/`schoollife`/`classlife` all extend — `timeline` and
`downloader` are unaffected, they're constructed without a
`moduleName`) is:
```js
isModuleAvailableForSelectedAccount() {
  if (!this.moduleName) throw Error(...);
  return typeof this.getSelectedAccount().modules.find(
    (o) => o.code === this.moduleName,
  ) < "u";
}
```
`getSelectedAccount()` calls `getSelectedAccountWithModuleName(this.moduleName)`,
which — because `this.moduleName` is set for all five of the above
modules — calls `isModuleAvailableForSelectedAccount()` again. Unconditional
recursion, no base case. **This means 5 of our 7 data-fetching methods
would never have worked even with a perfectly valid, non-expired
session** — it was simply never reached before, because `credentials.accounts`
was always empty first (Bug 1's effect) and `checkSelectedAccount()` throws
before ever reaching this code.

**Verified live, with zero network calls and zero real credentials**: a
throwaway script (`new Client({ token: 'fake', accounts: [<fabricated
but structurally valid account>], selectedAccounts: 0 })`, then
`client.marks.getSelectedAccount()` with a patched call counter) showed
unbounded recursive calls — confirming this is real, not a misreading of
minified code.

**Decision (discussed with the user, who approved this exact scope):**
patch both bugs from inside our own adapter — no fork, no rewrite of the
affected methods from scratch (that remains "Option C" if this stops
being viable) — and open an upstream issue. This does **not** by itself
fix the deeper, still-unconfirmed question of *why* `refreshToken` is
rejected by the real API so soon after a fresh login, or the related
design question (`ensureClient` refreshes proactively on every process's
first call, rather than trying the existing token first) the user's own
bug report raised — both are explicitly out of scope for this amendment
and are called out again at the end as a follow-up decision, not silently
folded in.

**Files:**
- Modify: `src/client/blocksDirecteAdapter.ts`
- Create: `test/client/blocksDirecteAdapter.test.ts`

**Interfaces:**
- Consumes: `Client`, `Credential`, `Account` (all exported by
  `@blockshub/blocksdirecte`), `PossiblyExpiredSessionError` (Task 4's
  amendment).
- Produces: `patchBrokenModuleAvailabilityCheck(client)`,
  `assertRefreshSucceeded(result)` — both exported from
  `blocksDirecteAdapter.ts` specifically so they're unit-testable without
  ever invoking the real (broken) recursive path or a real network call.

**Testing note — do NOT write a test that exercises the original,
unpatched `isModuleAvailableForSelectedAccount`.** It's unconditional
synchronous recursion; depending on stack size this can spin for a very
long time (observed: 120+ seconds) burning CPU before Node throws
`RangeError: Maximum call stack size exceeded` — a single-threaded hang
long enough to make a test runner's own timeout unreliable. Every test
below only ever calls the *patched* method, proven correct by its return
value and by the test suite completing normally at all.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/client/blocksDirecteAdapter.test.ts
import { Client, type Account, type Credential } from '@blockshub/blocksdirecte';
import { describe, expect, it } from 'vitest';
import { assertRefreshSucceeded, patchBrokenModuleAvailabilityCheck } from '../../src/client/blocksDirecteAdapter.js';
import { PossiblyExpiredSessionError } from '../../src/client/errors.js';

function makeFakeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 12345,
    typeCompte: 'E' as Account['typeCompte'],
    modules: [{ code: 'NOTES', enable: true, ordre: 1, badge: 0, params: {} }],
    profile: { classe: { id: 1, code: 'X', libelle: 'X', estNote: 1 } } as Account['profile'],
  } as Account;
}

function makeFakeCredential(account: Account): Credential {
  return { token: 'fake-token', accounts: [account], selectedAccounts: 0 };
}

describe('patchBrokenModuleAvailabilityCheck', () => {
  it('returns the selected account without recursing, for a module present on the account', () => {
    const client = new Client(makeFakeCredential(makeFakeAccount()));
    patchBrokenModuleAvailabilityCheck(client);

    const account = client.marks.getSelectedAccount();

    expect(account.id).toBe(12345);
  });

  it('reports a module as unavailable when the account does not list it', () => {
    const client = new Client(makeFakeCredential(makeFakeAccount({ modules: [] })));
    patchBrokenModuleAvailabilityCheck(client);

    const available = (client.marks as unknown as { isModuleAvailableForSelectedAccount(): boolean }).isModuleAvailableForSelectedAccount();

    expect(available).toBe(false);
  });

  it('patches all five affected modules (marks, homework, timetable, schoollife, classlife)', () => {
    const client = new Client(
      makeFakeCredential(
        makeFakeAccount({
          modules: [
            { code: 'NOTES', enable: true, ordre: 1, badge: 0, params: {} },
            { code: 'EDT', enable: true, ordre: 2, badge: 0, params: {} },
            { code: 'CAHIER_DE_TEXTES', enable: true, ordre: 3, badge: 0, params: {} },
            { code: 'VIE_SCOLAIRE', enable: true, ordre: 4, badge: 0, params: {} },
            { code: 'VIE_DE_LA_CLASSE', enable: true, ordre: 5, badge: 0, params: {} },
          ],
        }),
      ),
    );
    patchBrokenModuleAvailabilityCheck(client);

    expect(client.marks.getSelectedAccount().id).toBe(12345);
    expect(client.homework.getSelectedAccount().id).toBe(12345);
    expect(client.timetable.getSelectedAccount().id).toBe(12345);
    expect(client.schoollife.getSelectedAccount().id).toBe(12345);
    expect(client.classlife.getSelectedAccount().id).toBe(12345);
  });
});

describe('assertRefreshSucceeded', () => {
  it('throws PossiblyExpiredSessionError when the result has an empty token and no accounts', () => {
    expect(() => assertRefreshSucceeded({ token: '', accounts: [] })).toThrow(PossiblyExpiredSessionError);
  });

  it('throws when accounts is empty even if a token is present', () => {
    expect(() => assertRefreshSucceeded({ token: 'x', accounts: [] })).toThrow(PossiblyExpiredSessionError);
  });

  it('does not throw when both token and a non-empty accounts array are present', () => {
    expect(() => assertRefreshSucceeded({ token: 'x', accounts: [{}] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/client/blocksDirecteAdapter.test.ts`
Expected: FAIL — `patchBrokenModuleAvailabilityCheck`/`assertRefreshSucceeded`
are not exported yet.

- [ ] **Step 3: Add the two patches to `src/client/blocksDirecteAdapter.ts`**

Add `Account` to the existing `@blockshub/blocksdirecte` import (it's
already exported by the library):

```typescript
import {
  Client,
  InvalidCredentials,
  Invalid2FAKey,
  Require2FA,
  type Account,
  type Credential,
} from '@blockshub/blocksdirecte';
```

Add these two new exported functions (near the top, after `assertPresent`):

```typescript
interface PatchableModule {
  credentials: Credential;
  moduleName?: string;
  isModuleAvailableForSelectedAccount(): boolean;
}

const PATCHED_MODULE_KEYS = ['marks', 'homework', 'timetable', 'schoollife', 'classlife'] as const;

/**
 * Works around a confirmed bug in @blockshub/blocksdirecte@0.0.9-alpha:
 * Modules.prototype.isModuleAvailableForSelectedAccount calls
 * this.getSelectedAccount(), which calls back into
 * isModuleAvailableForSelectedAccount() — unconditional recursion for
 * every module built with a moduleName (these five; timeline/downloader
 * are unaffected). This reimplements the intended check directly against
 * the credentials the caller already validated, with no recursion.
 * Remove once fixed upstream.
 */
export function patchBrokenModuleAvailabilityCheck(client: Client): void {
  for (const key of PATCHED_MODULE_KEYS) {
    const moduleInstance = client[key] as unknown as PatchableModule;
    moduleInstance.isModuleAvailableForSelectedAccount = function (this: PatchableModule): boolean {
      const account: Account = this.credentials.accounts[this.credentials.selectedAccounts];
      return account.modules.some((entry) => entry.code === this.moduleName);
    };
  }
}

/**
 * Works around a confirmed bug in @blockshub/blocksdirecte@0.0.9-alpha:
 * AuthModules.prototype.refreshToken only recognizes response codes 250
 * and 505 — any other code (including an expired/invalid session) falls
 * through to its success path with an empty accounts array and an empty
 * token, indistinguishable from a real success without this check.
 * Remove once fixed upstream.
 */
export function assertRefreshSucceeded(result: { token: string; accounts: unknown[] }): void {
  if (!result.token || result.accounts.length === 0) {
    throw new PossiblyExpiredSessionError(
      "École Directe a refusé le rafraîchissement de session (bug connu de @blockshub/blocksdirecte : les codes d'expiration ne sont pas détectés et un résultat vide est traité comme un succès).",
    );
  }
}
```

Update `refreshCredential` to call `assertRefreshSucceeded`:

```typescript
async function refreshCredential(session: Session): Promise<Credential> {
  const bootstrap = new Client();
  const result = await bootstrap.auth.refreshToken(
    session.username,
    session.accountKind as AccountKindValue,
    session.accessToken,
    session.cnKey,
    session.cvKey,
    session.deviceUUID,
  );
  assertRefreshSucceeded(result);
  return { token: result.token, accounts: result.accounts, selectedAccounts: 0 };
}
```

Update `ensureClient` to patch every `Client` it constructs:

```typescript
async function ensureClient(session: Session): Promise<Client> {
  const cached = credentialCache.get(session.username);
  if (cached) {
    const client = new Client(cached);
    patchBrokenModuleAvailabilityCheck(client);
    return client;
  }
  const refreshed = await refreshCredential(session);
  credentialCache.set(session.username, refreshed);
  const client = new Client(refreshed);
  patchBrokenModuleAvailabilityCheck(client);
  return client;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/client/blocksDirecteAdapter.test.ts`
Expected: PASS (6 tests).

Run: `npm run build && npm run typecheck && npm test` (full suite) —
confirm nothing in Tasks 1-14 regressed.

- [ ] **Step 5: Commit**

```bash
git add src/client/blocksDirecteAdapter.ts test/client/blocksDirecteAdapter.test.ts
git commit -m "fix: work around two confirmed @blockshub/blocksdirecte bugs (silent refresh failure, module-check recursion)"
```

**Deliberately not done here — flag back to the user, don't decide silently:**
the proactive refresh in `ensureClient`'s cache-miss path (refreshing on
every fresh process start rather than trying the existing token first)
is a separate design question the user's own bug report raised. This
amendment makes that path fail *cleanly* (a typed, retriable error
instead of a confusing crash) but does not remove the unnecessary
refresh attempt itself. Revisit only if the user asks to.

---

## Task 5: Pure BlocksDirecte → DTO mappers

**Context for the implementer:** `@blockshub/blocksdirecte`'s bundled
`.d.ts` only re-exports a handful of types (`Client`, `Account`,
`Credential`, `DoubleAuthQuestions`, `DoubleAuthResult`, `Invalid2FAKey`,
`InvalidCredentials`, `Module`, `RequestOptions`, `Require2FA`,
`SchoolLifeAttendanceItem`, `SchoolLifeAttendanceItemType`,
`SchoolLifeConductItem`, `SchoolLifeExemptionItem`, `ServerResponse`,
`TimetableCourse`, `TimetableCourseType`). Types like `Marks`, `Homework`,
`HomeworkUpcoming`, `SchoolLife`, `ClassLife`, `PersonalTimelineItem` are
used as method return types but **not exported by name** — importing them
directly (`import { Marks } from '@blockshub/blocksdirecte'`) fails to
compile. Derive them structurally instead, anchored on the exported
`Client` class, e.g. `Awaited<ReturnType<InstanceType<typeof Client>['marks']['getMark']>>`.

**Files:**
- Create: `src/client/mappers.ts`
- Create: `test/fixtures/blocksDirecteFixtures.ts`
- Test: `test/client/mappers.test.ts`

**Interfaces:**
- Consumes: `Grade`, `HomeworkItem`, `TimetableSlot`, `SchoolLifeEntry`,
  `ClassLifeSummary`, `TimelineEntry` from `src/client/types.ts` (Task 2).
- Produces: `mapGrades`, `mapHomework`, `mapTimetable`, `mapSchoolLife`,
  `mapClassLife`, `mapTimeline`, `stripHtml` — consumed by Task 6.

**Note on `mapHomework`'s signature:** `getHomeworksForDate(date)`'s
response does include its own `date` field, but relying on it to match
what we requested is unverified — it's only guaranteed by our own
fixture, not by anything documented. Since the caller (Task 6) already
knows which date it asked for, `mapHomework` takes `{ date, response }`
pairs and uses the caller-supplied `date` as the source of truth for
`dueDate`, never reading `response.date`.

- [ ] **Step 1: Write `test/fixtures/blocksDirecteFixtures.ts`** (fixture builders with realistic defaults, overridable per test)

```typescript
import type { Client, TimetableCourse, TimetableCourseType, SchoolLifeAttendanceItem, SchoolLifeAttendanceItemType, SchoolLifeConductItem, SchoolLifeConductItemType, SchoolLifeExemptionItem } from '@blockshub/blocksdirecte';

type BDClient = InstanceType<typeof Client>;
export type RawMark = Awaited<ReturnType<BDClient['marks']['getMark']>>['notes'][number];
export type RawHomeworkDate = Awaited<ReturnType<BDClient['homework']['getHomeworksForDate']>>;
export type RawHomeworkSubject = RawHomeworkDate['matieres'][number];
export type RawSchoolLife = Awaited<ReturnType<BDClient['schoollife']['getSchoolLife']>>;
export type RawClassLife = Awaited<ReturnType<BDClient['classlife']['getClassLife']>>;
export type RawComment = RawClassLife['commentaires'][number];
export type RawPersonalTimelineItem = Awaited<ReturnType<BDClient['timeline']['getPersonalTimeline']>>[number];

export function makeRawMark(overrides: Partial<RawMark> = {}): RawMark {
  return {
    id: 1,
    devoir: 'Contrôle',
    codePeriode: 'A001',
    codeMatiere: 'MATH',
    libelleMatiere: 'Mathématiques',
    codeSousMatiere: '',
    typeDevoir: '',
    enLettre: false,
    commentaire: '',
    uncSujet: '',
    uncCorrige: '',
    date: '2026-01-15',
    dateSaisie: '2026-01-16',
    coef: '1',
    noteSur: '20',
    valeur: '14,5',
    valeurisee: true,
    nonSignificatif: false,
    moyenneClasse: '12,3',
    minClasse: '5',
    maxClasse: '19',
    elementsProgramme: [],
    ...overrides,
  };
}

export function makeRawHomeworkSubject(overrides: Partial<RawHomeworkSubject> = {}): RawHomeworkSubject {
  return {
    entityCode: 'C1',
    entityLibelle: '1ère A',
    entityType: 'C' as RawHomeworkSubject['entityType'],
    matiere: 'Mathématiques',
    codeMatiere: 'MATH',
    nomProf: 'M. Martin',
    id: 1,
    interrogation: false,
    blogActif: false,
    nbJourMaxRenduDevoir: 0,
    aFaire: {
      idDevoir: 42,
      contenu: '<p>Exercices 1 à 5 page 30</p>',
      rendreEnLigne: false,
      donneLe: '2026-01-10',
      effectue: false,
      ressource: '',
      documentsRendusDeposes: false,
      ressourceDocuments: [],
      documents: [],
      commentaires: [],
      elementsProg: [],
      liensManuel: [],
      documentsRendus: [],
      tags: [],
      cdtPersonnalises: [],
      contenuDeSeance: { contenu: '', documents: [], commentaires: [] },
    },
    ...overrides,
  };
}

export function makeRawTimetableCourse(overrides: Partial<TimetableCourse> = {}): TimetableCourse {
  return {
    id: 1,
    text: '',
    matiere: 'Mathématiques',
    codeMatiere: 'MATH',
    typeCours: 'COURS' as TimetableCourseType,
    start_date: '2026-01-15 08:00',
    end_date: '2026-01-15 09:00',
    color: '',
    dispensable: false,
    dispense: 0,
    prof: 'M. Martin',
    salle: 'B12',
    classeId: 1,
    classe: '1ère A',
    classeCode: '1A',
    groupeId: 0,
    groupe: '',
    groupeCode: '',
    isFlexible: false,
    icone: '',
    isModifie: false,
    contenuDeSeance: false,
    devoirAFaire: false,
    isAnnule: false,
    evenementId: 0,
    ...overrides,
  };
}

export function makeRawSchoolLife(overrides: Partial<RawSchoolLife> = {}): RawSchoolLife {
  return {
    absencesRetards: [],
    dispenses: [],
    sanctionsEncouragements: [],
    permisPoint: { idPermis: 0, libellePermis: '', dateDebut: '', dateFin: '', totalPoints: 0, evenements: [] },
    parametrage: {
      justificationEnLigne: false,
      absenceCommentaire: false,
      retardCommentaire: false,
      sanctionsVisible: false,
      sanctionParQui: false,
      sanctionCommentaire: false,
      encouragementsVisible: false,
      encouragementParQui: false,
      encouragementCommentaire: false,
      afficherPermisPoint: false,
    },
    ...overrides,
  };
}

export function makeRawAttendanceItem(overrides: Partial<SchoolLifeAttendanceItem> = {}): SchoolLifeAttendanceItem {
  return {
    id: 1,
    idEleve: 1,
    nomEleve: 0,
    typeElement: 'Absence' as SchoolLifeAttendanceItemType,
    date: '2026-01-10',
    displayDate: '10/01/2026',
    libelle: 'Absence non justifiée',
    motif: '',
    justifie: false,
    par: '',
    pointsPermis: 0,
    commentaire: '',
    typeJustification: '',
    justifieEd: false,
    dontNeedJustifiePrim: false,
    aFaire: '',
    dateDeroulement: '',
    matiere: '',
    presence: false,
    jour: 0,
    ...overrides,
  };
}

export function makeRawExemptionItem(overrides: Partial<SchoolLifeExemptionItem> = {}): SchoolLifeExemptionItem {
  return { ...makeRawAttendanceItem(), typeElement: 'Dispense', ...overrides } as SchoolLifeExemptionItem;
}

export function makeRawConductItem(overrides: Partial<SchoolLifeConductItem> = {}): SchoolLifeConductItem {
  return {
    ...makeRawAttendanceItem(),
    typeElement: 'Punition' as SchoolLifeConductItemType,
    auteur: { id: 1, nom: 'Dupont', prenom: 'Marie', civilite: 'Mme', particule: '', type: 'P' as SchoolLifeConductItem['auteur']['type'] },
    ...overrides,
  } as SchoolLifeConductItem;
}

export function makeRawComment(overrides: Partial<RawComment> = {}): RawComment {
  return {
    id: 1,
    idAuteur: 10,
    profilAuteur: 'P' as RawComment['profilAuteur'],
    auteur: 'M. Martin',
    date: '2026-01-09',
    message: 'Bon travail cette semaine.',
    supprime: false,
    ...overrides,
  };
}

export function makeRawClassLife(overrides: Partial<RawClassLife> = {}): RawClassLife {
  return {
    classe: '1ère A',
    contenu: '',
    idCDT: 1,
    profPrincipal: false,
    commentaires: [],
    fichiers: [],
    matieres: { libelle: '', id: '', idCDT: 1, dateMiseAJour: '2026-01-10', contenu: '', commentaires: [], fichiers: [] },
    ...overrides,
  };
}

export function makeRawPersonalTimelineItem(overrides: Partial<RawPersonalTimelineItem> = {}): RawPersonalTimelineItem {
  return {
    date: '2026-01-10',
    typeElement: 'Note' as RawPersonalTimelineItem['typeElement'],
    idElement: 1,
    titre: 'Nouvelle note',
    soustitre: 'Mathématiques',
    contenu: '',
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// test/client/mappers.test.ts
import { describe, expect, it } from 'vitest';
import { mapClassLife, mapGrades, mapHomework, mapSchoolLife, mapTimeline, mapTimetable, stripHtml } from '../../src/client/mappers.js';
import {
  makeRawAttendanceItem,
  makeRawClassLife,
  makeRawComment,
  makeRawConductItem,
  makeRawExemptionItem,
  makeRawHomeworkSubject,
  makeRawMark,
  makeRawPersonalTimelineItem,
  makeRawSchoolLife,
  makeRawTimetableCourse,
} from '../fixtures/blocksDirecteFixtures.js';

describe('mapGrades', () => {
  it('parses French decimal notation and flags non-numeric grades as null', () => {
    const [graded, absent] = mapGrades([
      makeRawMark({ id: 1, valeur: '14,5', valeurisee: true, nonSignificatif: false }),
      makeRawMark({ id: 2, valeur: 'Absent', valeurisee: false }),
    ]);

    expect(graded).toMatchObject({ id: '1', value: 14.5, scale: 20, coefficient: 1, classAverage: 12.3 });
    expect(absent.value).toBeNull();
  });
});

describe('stripHtml', () => {
  it('removes tags, decodes common entities, and collapses whitespace', () => {
    expect(stripHtml('<p>Exercices 1 &amp; 5   page&nbsp;30</p>')).toBe('Exercices 1 & 5 page 30');
  });
});

describe('mapHomework', () => {
  it('flattens per-date subjects that have homework, using the requested date (not the response date), skipping subjects without homework, and stripping HTML', () => {
    const items = mapHomework([
      {
        date: '2026-01-12',
        response: { date: '2099-12-31', matieres: [makeRawHomeworkSubject(), makeRawHomeworkSubject({ aFaire: undefined })] },
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '42',
      subject: 'Mathématiques',
      dueDate: '2026-01-12',
      done: false,
      description: 'Exercices 1 à 5 page 30',
    });
  });
});

describe('mapTimetable', () => {
  it('maps course slots, treating empty prof/salle as null', () => {
    const [slot] = mapTimetable([makeRawTimetableCourse({ prof: '', salle: 'B12', isAnnule: true })]);
    expect(slot).toMatchObject({ teacher: null, room: 'B12', cancelled: true });
  });
});

describe('mapSchoolLife', () => {
  it('combines attendance, exemptions and conduct into one flat list', () => {
    const entries = mapSchoolLife(
      makeRawSchoolLife({
        absencesRetards: [makeRawAttendanceItem({ id: 1 })],
        dispenses: [makeRawExemptionItem({ id: 2 })],
        sanctionsEncouragements: [makeRawConductItem({ id: 3 })],
      }),
    );
    expect(entries.map((e) => e.id)).toEqual(['1', '2', '3']);
  });
});

describe('mapClassLife', () => {
  it('maps to a single summary object, correctly reading auteur as a plain string (unlike SchoolLifeConductItem.auteur, which is an object)', () => {
    const summary = mapClassLife(
      makeRawClassLife({ classe: '1ère A', contenu: 'RAS', commentaires: [makeRawComment()] }),
    );

    expect(summary).toMatchObject({ className: '1ère A', content: 'RAS', updatedAt: '2026-01-10' });
    expect(summary.comments).toEqual([
      { id: '1', author: 'M. Martin', date: '2026-01-09', message: 'Bon travail cette semaine.' },
    ]);
  });
});

describe('mapTimeline', () => {
  it('joins titre and soustitre into a summary', () => {
    const [entry] = mapTimeline([makeRawPersonalTimelineItem({ titre: 'Nouvelle note', soustitre: 'Maths' })]);
    expect(entry.summary).toBe('Nouvelle note — Maths');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/client/mappers.test.ts`
Expected: FAIL — `Cannot find module '../../src/client/mappers.js'`.

- [ ] **Step 4: Write `src/client/mappers.ts`**

```typescript
import type { Client, TimetableCourse } from '@blockshub/blocksdirecte';
import type { ClassLifeSummary, Grade, HomeworkItem, SchoolLifeEntry, TimelineEntry, TimetableSlot } from './types.js';

type BDClient = InstanceType<typeof Client>;
type RawMark = Awaited<ReturnType<BDClient['marks']['getMark']>>['notes'][number];
type RawHomeworkDate = Awaited<ReturnType<BDClient['homework']['getHomeworksForDate']>>;
type RawSchoolLife = Awaited<ReturnType<BDClient['schoollife']['getSchoolLife']>>;
type RawClassLife = Awaited<ReturnType<BDClient['classlife']['getClassLife']>>;
type RawPersonalTimelineItem = Awaited<ReturnType<BDClient['timeline']['getPersonalTimeline']>>[number];

function parseFrenchNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw.replace(',', '.').trim());
  return Number.isFinite(value) ? value : null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mapGrades(notes: RawMark[]): Grade[] {
  return notes.map((note) => ({
    id: String(note.id),
    subject: note.libelleMatiere,
    label: note.devoir,
    value: note.valeurisee && !note.nonSignificatif ? parseFrenchNumber(note.valeur) : null,
    scale: parseFrenchNumber(note.noteSur) ?? 20,
    date: note.date,
    coefficient: parseFrenchNumber(note.coef) ?? 1,
    classAverage: parseFrenchNumber(note.moyenneClasse),
  }));
}

export function mapHomework(perDate: Array<{ date: string; response: RawHomeworkDate }>): HomeworkItem[] {
  const items: HomeworkItem[] = [];
  for (const { date, response } of perDate) {
    for (const subject of response.matieres) {
      if (!subject.aFaire) continue;
      items.push({
        id: String(subject.aFaire.idDevoir),
        subject: subject.matiere,
        dueDate: date,
        description: stripHtml(subject.aFaire.contenu),
        done: subject.aFaire.effectue,
      });
    }
  }
  return items;
}

export function mapTimetable(courses: TimetableCourse[]): TimetableSlot[] {
  return courses.map((course) => ({
    id: String(course.id),
    subject: course.matiere,
    teacher: course.prof || null,
    room: course.salle || null,
    start: course.start_date,
    end: course.end_date,
    cancelled: course.isAnnule,
  }));
}

export function mapSchoolLife(schoolLife: RawSchoolLife): SchoolLifeEntry[] {
  const attendance: SchoolLifeEntry[] = schoolLife.absencesRetards.map((item) => ({
    id: String(item.id),
    type: item.typeElement,
    date: item.date,
    description: item.libelle,
    justified: item.justifie,
  }));
  const exemptions: SchoolLifeEntry[] = schoolLife.dispenses.map((item) => ({
    id: String(item.id),
    type: 'Dispense',
    date: item.date,
    description: item.libelle,
    justified: item.justifie,
  }));
  const conduct: SchoolLifeEntry[] = schoolLife.sanctionsEncouragements.map((item) => ({
    id: String(item.id),
    type: item.typeElement,
    date: item.date,
    description: item.libelle,
    justified: null,
  }));
  return [...attendance, ...exemptions, ...conduct];
}

export function mapClassLife(classLife: RawClassLife): ClassLifeSummary {
  return {
    className: classLife.classe,
    content: classLife.contenu,
    updatedAt: classLife.matieres?.dateMiseAJour ?? '',
    comments: classLife.commentaires.map((comment) => ({
      id: String(comment.id),
      author: comment.auteur,
      date: comment.date,
      message: comment.message,
    })),
  };
}

export function mapTimeline(items: RawPersonalTimelineItem[]): TimelineEntry[] {
  return items.map((item) => ({
    id: String(item.idElement),
    date: item.date,
    type: item.typeElement,
    summary: item.soustitre ? `${item.titre} — ${item.soustitre}` : item.titre,
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/client/mappers.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/client/mappers.ts test/fixtures/blocksDirecteFixtures.ts test/client/mappers.test.ts
git commit -m "feat: pure BlocksDirecte-to-DTO mappers with fixtures"
```

---

## Task 6: BlocksDirecte adapter (login, QCM, refresh, data calls)

**Context for the implementer:** `AuthModules.loginUsername` and
`refreshToken` don't return a discriminated union for the QCM step —
`loginUsername` **throws** `Require2FA` (which carries `.token`) when a
new device needs the security question, and throws `InvalidCredentials`
on bad creds; `send2FAQuestion` throws `Invalid2FAKey` on a wrong answer.
All three are real exported classes from `@blockshub/blocksdirecte` — use
`instanceof`, not string matching.

`BlocksDirecte`'s `Client` is **stateful**: its module instances
(`client.marks`, `client.homework`, ...) share one mutable internal
`Credential` object. Our `EcoleDirecteClient` interface is
**stateless-per-call** (every method takes an explicit `session`). To
bridge this without fabricating fake `Account` objects (guessing at the
~15 required fields would risk silently hitting the wrong student's
data), this adapter keeps a private, in-memory
`Map<username, Credential>` populated **only** from real
`AuthentificationCredentialWithToken` results returned by
`loginUsername`/`refreshToken` themselves — never constructed by hand.
`ensureClient()` reconstructs a fresh `Client` from that cached
`Credential` per call (cheap — no network cost), refreshing first if the
cache is cold (e.g., right after a process restart).

`downloader.getStream(fileId, fileType)` returns only a raw byte stream —
no filename or MIME type. `fileType` must be supplied by the caller (the
tool's input), and the adapter can't derive a real MIME type from the
library, so it uses `application/octet-stream` as an honest fallback —
this is a known limitation, not a guess to "fix" here.

Every data-fetching method below is wrapped in `wrapCall` (Task 4) so a
raw BlocksDirecte error gets a chance to become a typed
`EcoleDirecteApiError` — this is what makes `withAutoRefresh`'s 520/525
retry reachable at all; without it, a real expired token would just
throw an unrecognized error straight through.

`getUpcomingHomework()` — the only bulk homework listing BlocksDirecte
exposes — **only ever returns upcoming (not-yet-due) homework**; École
Directe doesn't expose a bulk "past homework" listing through it. So
`getHomework(session, fromDate, toDate)` only ever returns entries within
`[today, toDate]` in practice, even when `fromDate` is in the past — this
is documented in the `get_homework` tool's description (Task 12), not
silently swallowed. Also note: since `getHomeworksForDate`'s own `date`
field isn't trusted (see Task 5), each date is fetched **sequentially**
(not `Promise.all`) and paired with the date we requested — a `Promise.all`
here would fire up to ~14 concurrent requests at the BlocksDirecte layer,
which the Task 7 cache/queue decorator sits *above* and can't see or
serialize (it only sees this one `getHomework` call as a single unit).

**Files:**
- Create: `src/client/blocksDirecteAdapter.ts`

**Interfaces:**
- Consumes: `EcoleDirecteClient`, all DTOs (Task 2); `mapGrades`,
  `mapHomework`, `mapTimetable`, `mapSchoolLife`, `mapClassLife`,
  `mapTimeline` (Task 5); `InvalidCredentialsError`,
  `InvalidTwoFactorAnswerError`, `wrapCall`, `mapCaughtError` (Task 4).
- Produces: `createBlocksDirecteClient(): EcoleDirecteClient` — consumed
  by Tasks 9, 14, 16.

**No automated test for this task** — it only wraps real network calls to
École Directe and can't be verified without live credentials. It's
verified end-to-end by the smoke test in Task 16, run manually against
the user's real account.

- [ ] **Step 1: Write `src/client/blocksDirecteAdapter.ts`**

```typescript
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  Client,
  InvalidCredentials,
  Invalid2FAKey,
  Require2FA,
  type Credential,
} from '@blockshub/blocksdirecte';
import { InvalidCredentialsError, InvalidTwoFactorAnswerError, mapCaughtError, wrapCall } from './errors.js';
import { mapClassLife, mapGrades, mapHomework, mapSchoolLife, mapTimeline, mapTimetable } from './mappers.js';
import type { EcoleDirecteClient, LoginCredentials, Session, TwoFactorChallenge } from './types.js';

type AccountKindValue = Parameters<InstanceType<typeof Client>['auth']['refreshToken']>[1];

const credentialCache = new Map<string, Credential>();

function accountFromCredential(credential: Credential) {
  const account = credential.accounts[credential.selectedAccounts];
  if (!account) throw new Error('École Directe credential has no selected account');
  return account;
}

function sessionFromCredential(
  base: { username: string; deviceUUID: string; cnKey?: string; cvKey?: string },
  credential: Credential,
): Session {
  const account = accountFromCredential(credential);
  return {
    username: base.username,
    deviceUUID: base.deviceUUID,
    accountId: String(account.id),
    accountKind: account.typeCompte,
    displayName: `${account.prenom} ${account.nom}`.trim(),
    accessToken: credential.token ?? account.accessToken,
    cnKey: base.cnKey,
    cvKey: base.cvKey,
    updatedAt: new Date().toISOString(),
  };
}

async function refreshCredential(session: Session): Promise<Credential> {
  const bootstrap = new Client();
  const result = await bootstrap.auth.refreshToken(
    session.username,
    session.accountKind as AccountKindValue,
    session.accessToken,
    session.cnKey,
    session.cvKey,
    session.deviceUUID,
  );
  return { token: result.token, accounts: result.accounts, selectedAccounts: 0 };
}

async function ensureClient(session: Session): Promise<Client> {
  const cached = credentialCache.get(session.username);
  if (cached) return new Client(cached);
  const refreshed = await refreshCredential(session);
  credentialCache.set(session.username, refreshed);
  return new Client(refreshed);
}

export function createBlocksDirecteClient(): EcoleDirecteClient {
  return {
    async login({ username, password, deviceUUID }: LoginCredentials): Promise<Session | TwoFactorChallenge> {
      const client = new Client();
      try {
        const result = await client.auth.loginUsername(username, password, undefined, undefined, true, deviceUUID);
        const credential: Credential = { token: result.token, accounts: result.accounts, selectedAccounts: 0 };
        credentialCache.set(username, credential);
        return sessionFromCredential({ username, deviceUUID }, credential);
      } catch (error) {
        if (error instanceof Require2FA) {
          const question = await client.auth.get2FAQuestion(error.token);
          return { token: error.token, question: question.question, propositions: question.propositions };
        }
        if (error instanceof InvalidCredentials) {
          throw new InvalidCredentialsError(505, error.message);
        }
        throw mapCaughtError(error);
      }
    },

    async completeTwoFactor(
      challenge: TwoFactorChallenge,
      answer: string,
      { username, password, deviceUUID }: LoginCredentials,
    ): Promise<Session> {
      const client = new Client();
      let cnCv;
      try {
        cnCv = await client.auth.send2FAQuestion(answer, challenge.token);
      } catch (error) {
        if (error instanceof Invalid2FAKey) throw new InvalidTwoFactorAnswerError(0, error.message);
        throw error;
      }
      const result = await client.auth.loginUsername(username, password, cnCv.cn, cnCv.cv, true, deviceUUID);
      const credential: Credential = { token: result.token, accounts: result.accounts, selectedAccounts: 0 };
      credentialCache.set(username, credential);
      return sessionFromCredential({ username, deviceUUID, cnKey: cnCv.cn, cvKey: cnCv.cv }, credential);
    },

    async refreshSession(session: Session): Promise<Session> {
      return wrapCall(async () => {
        const credential = await refreshCredential(session);
        credentialCache.set(session.username, credential);
        return sessionFromCredential(session, credential);
      });
    },

    async getGrades(session, schoolYear) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const marks = await client.marks.getMark(schoolYear);
        return mapGrades(marks.notes);
      });
    },

    async getHomework(session, fromDate, toDate) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const upcoming = await client.homework.getUpcomingHomework();
        const dates = Object.keys(upcoming).filter((date) => date >= fromDate && date <= toDate);
        const perDate: Array<{ date: string; response: Awaited<ReturnType<typeof client.homework.getHomeworksForDate>> }> = [];
        for (const date of dates) {
          const response = await client.homework.getHomeworksForDate(date);
          perDate.push({ date, response });
        }
        return mapHomework(perDate);
      });
    },

    async markHomeworkDone(session, homeworkId, done) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const id = Number(homeworkId);
        if (done) {
          await client.homework.markHomeworkAsDone(id);
        } else {
          await client.homework.markHomeworkAsUndone(id);
        }
      });
    },

    async getTimetable(session, fromDate, toDate) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const courses = await client.timetable.getTimetableBetweenDates(new Date(fromDate), new Date(toDate));
        return mapTimetable(courses);
      });
    },

    async getSchoolLife(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapSchoolLife(await client.schoollife.getSchoolLife());
      });
    },

    async getClassLife(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapClassLife(await client.classlife.getClassLife());
      });
    },

    async getTimeline(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapTimeline(await client.timeline.getPersonalTimeline());
      });
    },

    async downloadDocument(session, fileId, fileType, destinationDir) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const stream = await client.downloader.getStream(Number(fileId), fileType);
        if (!stream) throw new Error(`École Directe returned no content for document ${fileId}`);
        await mkdir(destinationDir, { recursive: true });
        const filename = fileId;
        const path = join(destinationDir, filename);
        await pipeline(Readable.fromWeb(stream), createWriteStream(path));
        const { size } = await stat(path);
        return { path, filename, mimeType: 'application/octet-stream', sizeBytes: size };
      });
    },

    async getAuthStatus(session) {
      return {
        sessionExists: session !== null,
        username: session?.username ?? null,
        lastRefreshAt: session?.updatedAt ?? null,
        lastErrorCode: null,
      };
    },
  };
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds with no type errors (this is the acceptance check for this task, in place of a unit test — see note above).

- [ ] **Step 3: Commit**

```bash
git add src/client/blocksDirecteAdapter.ts
git commit -m "feat: BlocksDirecte adapter for EcoleDirecteClient"
```

### Amendment: structural null/undefined guard (added after review)

**Why:** confirmed by reading `@blockshub/blocksdirecte`'s compiled
source directly — `getMark`, `getUpcomingHomework`,
`getHomeworksForDate`, `getTimetableBetweenDates`, `getSchoolLife`,
`getClassLife`, and `getPersonalTimeline` all do
`return (await this.restManager.post(...)).data` with **no check at
all** on the response. On an expired token, École Directe's numeric
`code` lives on the *outer* response object; these methods discard
everything except `.data` before returning, so the code never reaches
this adapter. The one observable symptom is `.data` coming back
`null`/`undefined` instead of the object/array the type signature
promises. Without a guard, that flows straight into a mapper (Task 5)
and throws a generic, unrecognized `TypeError` — `wrapCall` correctly
leaves it unmapped (nothing about a `TypeError` says "token expired"),
so `withAutoRefresh` never retries.

This guard is deliberately **strict**: it only fires on `null`/`undefined`,
never on a legitimately empty array (`[]`) or object (`{}`) — a school
with no homework today, or a subject with no grades yet, is a normal,
valid response and must not trigger a refresh.

`downloader.getStream` is **not** covered by this guard — its own type
signature already returns `ReadableStream | null`, meaning the library
itself treats `null` as a documented possible outcome (e.g. file not
found), not something this adapter can distinguish from "token expired"
the way it can for the other 7 methods. It keeps its existing plain
`Error` on `null`.

- [ ] **Step 4: Add the `assertPresent` helper and apply it to the 7 methods that need it**

Replace the existing `import { InvalidCredentialsError, InvalidTwoFactorAnswerError, mapCaughtError, wrapCall } from './errors.js';`
line at the top of `src/client/blocksDirecteAdapter.ts` with (adds
`PossiblyExpiredSessionError` — everything else on the line is
unchanged):

```typescript
import { InvalidCredentialsError, InvalidTwoFactorAnswerError, PossiblyExpiredSessionError, mapCaughtError, wrapCall } from './errors.js';
```

Add this helper function near the top of the file, after the type
aliases and before `credentialCache`:

```typescript
function assertPresent<T>(value: T | null | undefined, context: string): T {
  if (value === null || value === undefined) {
    throw new PossiblyExpiredSessionError(
      `École Directe (${context}) a renvoyé une réponse vide — session probablement expirée.`,
    );
  }
  return value;
}
```

Then wrap the raw library result in `assertPresent` in these 7 methods
(the file's other methods — `login`, `completeTwoFactor`, `refreshSession`,
`markHomeworkDone`, `downloadDocument`, `getAuthStatus` — are unchanged):

```typescript
    async getGrades(session, schoolYear) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const marks = assertPresent(await client.marks.getMark(schoolYear), 'getMark');
        return mapGrades(marks.notes);
      });
    },

    async getHomework(session, fromDate, toDate) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const upcoming = assertPresent(await client.homework.getUpcomingHomework(), 'getUpcomingHomework');
        const dates = Object.keys(upcoming).filter((date) => date >= fromDate && date <= toDate);
        const perDate: Array<{ date: string; response: Awaited<ReturnType<typeof client.homework.getHomeworksForDate>> }> = [];
        for (const date of dates) {
          const response = assertPresent(await client.homework.getHomeworksForDate(date), 'getHomeworksForDate');
          perDate.push({ date, response });
        }
        return mapHomework(perDate);
      });
    },

    async getTimetable(session, fromDate, toDate) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const courses = assertPresent(
          await client.timetable.getTimetableBetweenDates(new Date(fromDate), new Date(toDate)),
          'getTimetableBetweenDates',
        );
        return mapTimetable(courses);
      });
    },

    async getSchoolLife(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapSchoolLife(assertPresent(await client.schoollife.getSchoolLife(), 'getSchoolLife'));
      });
    },

    async getClassLife(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapClassLife(assertPresent(await client.classlife.getClassLife(), 'getClassLife'));
      });
    },

    async getTimeline(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapTimeline(assertPresent(await client.timeline.getPersonalTimeline(), 'getPersonalTimeline'));
      });
    },
```

Note: `assertPresent` throws inside the `wrapCall(async () => {...})`
callback, so it's still covered by `wrapCall`'s try/catch — but since
`PossiblyExpiredSessionError` is already an `EcoleDirecteApiError`
instance, `mapCaughtError`'s new already-typed-error guard (Task 4's
Amendment) means `wrapCall` rethrows it unchanged rather than trying to
re-map it through `extractErrorCode`.

- [ ] **Step 5: Type-check**

Run: `npm run build && npm run typecheck`
Expected: both succeed with no errors.

Run: `npm test` (full suite) — confirm nothing in Tasks 1-5 (including
Task 4's Amendment) regressed.

- [ ] **Step 6: Commit**

```bash
git add src/client/blocksDirecteAdapter.ts
git commit -m "feat: guard adapter data methods against null/undefined on expired sessions"
```

---

## Task 7: Caching + serialization decorator

**Files:**
- Create: `src/client/cachingClient.ts`
- Test: `test/client/cachingClient.test.ts`

**Interfaces:**
- Consumes: `EcoleDirecteClient` (Task 2); `FakeEcoleDirecteClient`, `makeSession` (Task 2).
- Produces: `createCachingClient(client, options?): EcoleDirecteClient` — consumed by Task 9.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/client/cachingClient.test.ts
import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { createCachingClient } from '../../src/client/cachingClient.js';

describe('createCachingClient', () => {
  it('caches getGrades results within the TTL', async () => {
    const fake = new FakeEcoleDirecteClient();
    let now = 0;
    const client = createCachingClient(fake, { ttlMs: 1000, now: () => now });
    const session = makeSession();

    await client.getGrades(session);
    await client.getGrades(session);

    expect(fake.callCounts.getGrades).toBe(1);
  });

  it('refetches after the TTL expires', async () => {
    const fake = new FakeEcoleDirecteClient();
    let now = 0;
    const client = createCachingClient(fake, { ttlMs: 1000, now: () => now });
    const session = makeSession();

    await client.getGrades(session);
    now = 2000;
    await client.getGrades(session);

    expect(fake.callCounts.getGrades).toBe(2);
  });

  it('does not cache getSchoolLife (only grades/homework/timetable are cached)', async () => {
    const fake = new FakeEcoleDirecteClient();
    const client = createCachingClient(fake);
    const session = makeSession();

    await client.getSchoolLife(session);
    await client.getSchoolLife(session);

    expect(fake.callCounts.getSchoolLife).toBe(2);
  });

  it('serializes outbound calls so the underlying client never sees overlapping calls', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.callDelayMs = 20;
    const client = createCachingClient(fake);
    const session = makeSession();

    await Promise.all([client.getSchoolLife(session), client.getClassLife(session)]);

    expect(fake.globalMaxConcurrent).toBe(1);
  });

  it('invalidates cached homework after markHomeworkDone', async () => {
    const fake = new FakeEcoleDirecteClient();
    const client = createCachingClient(fake);
    const session = makeSession();

    await client.getHomework(session, '2026-01-01', '2026-01-31');
    await client.markHomeworkDone(session, '42', true);
    await client.getHomework(session, '2026-01-01', '2026-01-31');

    expect(fake.callCounts.getHomework).toBe(2);
  });

  it('shares a single in-flight fetch between concurrent cache-miss callers instead of fetching twice', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.callDelayMs = 20;
    const client = createCachingClient(fake);
    const session = makeSession();

    await Promise.all([client.getGrades(session), client.getGrades(session)]);

    expect(fake.callCounts.getGrades).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/client/cachingClient.test.ts`
Expected: FAIL — `Cannot find module '../../src/client/cachingClient.js'`.

- [ ] **Step 3: Write `src/client/cachingClient.ts`**

```typescript
import type { EcoleDirecteClient, Session } from './types.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CachingClientOptions {
  ttlMs?: number;
  now?: () => number;
}

export function createCachingClient(
  client: EcoleDirecteClient,
  options: CachingClientOptions = {},
): EcoleDirecteClient {
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry<unknown>>();
  const inFlight = new Map<string, Promise<unknown>>();
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function invalidatePrefix(prefix: string): void {
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const entry = cache.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expiresAt > now()) {
      return Promise.resolve(entry.value);
    }
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = enqueue(fn)
      .then((value) => {
        cache.set(key, { value, expiresAt: now() + ttlMs });
        inFlight.delete(key);
        return value;
      })
      .catch((error) => {
        inFlight.delete(key);
        throw error;
      });
    inFlight.set(key, promise);
    return promise;
  }

  return {
    login: (credentials) => enqueue(() => client.login(credentials)),
    completeTwoFactor: (challenge, answer, credentials) => enqueue(() => client.completeTwoFactor(challenge, answer, credentials)),
    refreshSession: (session: Session) => enqueue(() => client.refreshSession(session)),
    getGrades: (session, schoolYear) => cached(`grades:${session.username}:${schoolYear ?? ''}`, () => client.getGrades(session, schoolYear)),
    getHomework: (session, fromDate, toDate) =>
      cached(`homework:${session.username}:${fromDate}:${toDate}`, () => client.getHomework(session, fromDate, toDate)),
    markHomeworkDone: (session, homeworkId, done) =>
      enqueue(() => client.markHomeworkDone(session, homeworkId, done)).then((result) => {
        invalidatePrefix(`homework:${session.username}:`);
        return result;
      }),
    getTimetable: (session, fromDate, toDate) =>
      cached(`timetable:${session.username}:${fromDate}:${toDate}`, () => client.getTimetable(session, fromDate, toDate)),
    getSchoolLife: (session) => enqueue(() => client.getSchoolLife(session)),
    getClassLife: (session) => enqueue(() => client.getClassLife(session)),
    getTimeline: (session) => enqueue(() => client.getTimeline(session)),
    downloadDocument: (session, fileId, fileType, destinationDir) =>
      enqueue(() => client.downloadDocument(session, fileId, fileType, destinationDir)),
    getAuthStatus: (session) => enqueue(() => client.getAuthStatus(session)),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/client/cachingClient.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/client/cachingClient.ts test/client/cachingClient.test.ts
git commit -m "feat: TTL cache with mutation invalidation, in-flight dedupe, serialized queue"
```

---

## Task 8: Config parsing

**Files:**
- Modify: `src/config.ts` (replace the Task 1 placeholder)
- Modify: `.env.example` (add `SESSION_MAX_AGE_MS`, see Step 3a below)
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `Config`, `loadConfig(env?): Config` — consumed by Tasks 11, 12, 13, 14.
  `Config.sessionMaxAgeMs` feeds `withAutoRefresh`'s preventive-refresh
  threshold (Task 4's Amendment), threaded through by Task 9's
  `createClient`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when env vars are unset', () => {
    const config = loadConfig({});
    expect(config.readOnly).toBe(false);
    expect(config.sessionPath).toContain('ecoledirecte-mcp');
    expect(config.downloadDir).toContain('ecoledirecte-mcp');
    expect(config.sessionMaxAgeMs).toBe(15 * 60 * 1000);
  });

  it('applies overrides from env vars', () => {
    const config = loadConfig({
      SESSION_PATH: '/tmp/s.json',
      DOWNLOAD_DIR: '/tmp/dl',
      READ_ONLY: 'true',
      SESSION_MAX_AGE_MS: '600000',
    });
    expect(config).toEqual({
      sessionPath: '/tmp/s.json',
      downloadDir: '/tmp/dl',
      readOnly: true,
      sessionMaxAgeMs: 600000,
    });
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    [undefined, false],
  ])('parses READ_ONLY=%s as %s', (raw, expected) => {
    const config = loadConfig(raw === undefined ? {} : { READ_ONLY: raw });
    expect(config.readOnly).toBe(expected);
  });

  it.each([
    [undefined, 15 * 60 * 1000],
    ['600000', 600000],
    ['not-a-number', 15 * 60 * 1000],
    ['-5', 15 * 60 * 1000],
  ])('parses SESSION_MAX_AGE_MS=%s as %s (falls back to the default on anything non-positive or unparseable)', (raw, expected) => {
    const config = loadConfig(raw === undefined ? {} : { SESSION_MAX_AGE_MS: raw });
    expect(config.sessionMaxAgeMs).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `loadConfig is not exported`.

- [ ] **Step 3: Rewrite `src/config.ts`**

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultSessionPath } from './store/sessionStore.js';

export interface Config {
  sessionPath: string;
  downloadDir: string;
  readOnly: boolean;
  sessionMaxAgeMs: number;
}

const DEFAULT_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    sessionPath: env.SESSION_PATH ?? defaultSessionPath(),
    downloadDir: env.DOWNLOAD_DIR ?? join(homedir(), '.local', 'share', 'ecoledirecte-mcp', 'downloads'),
    readOnly: parseBoolean(env.READ_ONLY, false),
    sessionMaxAgeMs: parsePositiveInt(env.SESSION_MAX_AGE_MS, DEFAULT_SESSION_MAX_AGE_MS),
  };
}
```

- [ ] **Step 3a: Add `SESSION_MAX_AGE_MS` to `.env.example`**

Append this to the existing file (current content: `SESSION_PATH`,
`DOWNLOAD_DIR`, `READ_ONLY` — leave those three untouched):

```
# Millisecondes avant de rafraîchir la session par précaution, même sans erreur
# (par défaut: 900000 = 15 min — valeur conservatrice, à ajuster une fois la vraie
# durée de vie du token observée, voir le smoke test)
SESSION_MAX_AGE_MS=
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (10 tests: 2 + 4 READ_ONLY cases + 4 SESSION_MAX_AGE_MS cases).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example test/config.test.ts
git commit -m "feat: env-based config parsing"
```

---

## Task 9: Client composition root

`SessionBox`/`createSessionBox` were already created in Task 2 (and are
already consumed directly by `withAutoRefresh` in Task 4) — this task is
just wiring the two decorators together.

**Files:**
- Create: `src/client/createClient.ts`
- Test: `test/client/createClient.test.ts`

**Interfaces:**
- Consumes: `EcoleDirecteClient`, `SessionBox`, `createSessionBox` (Task 2);
  `withAutoRefresh`, `WithAutoRefreshOptions`, `TokenExpiredError` (Task 4,
  including its Amendment); `createCachingClient` (Task 7);
  `FakeEcoleDirecteClient`, `makeSession`.
- Produces: `createClient(base, sessionBox, options?)` — consumed by
  Tasks 14, 16. `options.sessionMaxAgeMs` (from `Config.sessionMaxAgeMs`,
  Task 8) threads through to `withAutoRefresh`'s preventive-refresh
  threshold.

- [ ] **Step 1: Write the failing test**

```typescript
// test/client/createClient.test.ts
import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { TokenExpiredError } from '../../src/client/errors.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { createClient } from '../../src/client/createClient.js';

describe('createClient', () => {
  it('applies retry-on-expiry and updates the session box on refresh', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.refreshedSession = makeSession({ accessToken: 'new-token' });
    const box = createSessionBox(makeSession(), async () => {});
    const client = createClient(fake, box, { sessionMaxAgeMs: Number.POSITIVE_INFINITY });

    await client.getGrades(box.get()!);

    expect(box.get()!.accessToken).toBe('new-token');
  });

  it('applies caching on top of retry', async () => {
    const fake = new FakeEcoleDirecteClient();
    const box = createSessionBox(makeSession(), async () => {});
    const client = createClient(fake, box, { sessionMaxAgeMs: Number.POSITIVE_INFINITY });

    await client.getGrades(box.get()!);
    await client.getGrades(box.get()!);

    expect(fake.callCounts.getGrades).toBe(1);
  });

  it('threads sessionMaxAgeMs through to the preventive-refresh mechanism', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.refreshedSession = makeSession({ accessToken: 'new-token', updatedAt: '2026-01-01T00:10:00.000Z' });
    const box = createSessionBox(staleSession, async () => {});
    const client = createClient(fake, box, {
      sessionMaxAgeMs: 15 * 60 * 1000,
      now: () => new Date('2026-01-01T00:30:00.000Z').getTime(),
    });

    await client.getGrades(box.get()!);

    expect(fake.callCounts.refreshSession).toBe(1);
    expect(box.get()!.accessToken).toBe('new-token');
  });
});
```

Note: the first two tests pass `sessionMaxAgeMs: Number.POSITIVE_INFINITY`
for the same reason Task 4's existing tests do — `makeSession()`'s fixed
`updatedAt` would otherwise register as stale against a real clock and
trigger an unwanted preventive refresh, which isn't what those two tests
are about.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/client/createClient.test.ts`
Expected: FAIL — `Cannot find module '../../src/client/createClient.js'`.

- [ ] **Step 3: Write `src/client/createClient.ts`**

```typescript
import { createCachingClient } from './cachingClient.js';
import { withAutoRefresh, type WithAutoRefreshOptions } from './errors.js';
import type { SessionBox } from './sessionBox.js';
import type { EcoleDirecteClient } from './types.js';

export interface CreateClientOptions {
  sessionMaxAgeMs?: number;
  /** Injectable clock, tests only — forwarded to withAutoRefresh. */
  now?: () => number;
}

export function createClient(
  base: EcoleDirecteClient,
  sessionBox: SessionBox,
  options: CreateClientOptions = {},
): EcoleDirecteClient {
  const refreshOptions: WithAutoRefreshOptions = { maxAgeMs: options.sessionMaxAgeMs, now: options.now };
  return createCachingClient(withAutoRefresh(base, sessionBox, refreshOptions));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/client/createClient.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/client/createClient.ts test/client/createClient.test.ts
git commit -m "feat: client composition root"
```

---

## Task 10: CLI login flow (testable core)

**Files:**
- Create: `src/cli/login.ts`
- Test: `test/cli/login.test.ts`

**Interfaces:**
- Consumes: `EcoleDirecteClient`, `LoginCredentials`, `Session` (Task 2); `FakeEcoleDirecteClient`, `makeSession` (Task 2).
- Produces: `LoginIO`, `runLoginFlow(client, io, credentials): Promise<Session>` — consumed by Task 14.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/cli/login.test.ts
import { describe, expect, it, vi } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { runLoginFlow, type LoginIO } from '../../src/cli/login.js';

const credentials = { username: 'jdupont', password: 'secret', deviceUUID: 'device-1' };

describe('runLoginFlow', () => {
  it('returns the session directly when no QCM is required', async () => {
    const fake = new FakeEcoleDirecteClient();
    const io: LoginIO = { chooseAnswer: vi.fn() };

    const session = await runLoginFlow(fake, io, credentials);

    expect(session).toEqual(fake.session);
    expect(io.chooseAnswer).not.toHaveBeenCalled();
  });

  it('prompts for the QCM answer and completes login when required', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.twoFactorChallenge = { token: 't', question: 'Quelle est votre ville ?', propositions: ['Paris', 'Lyon'] };
    fake.session = makeSession({ displayName: 'Jean Dupont' });
    const io: LoginIO = { chooseAnswer: vi.fn().mockResolvedValue('Lyon') };

    const session = await runLoginFlow(fake, io, credentials);

    expect(io.chooseAnswer).toHaveBeenCalledWith('Quelle est votre ville ?', ['Paris', 'Lyon']);
    expect(fake.callCounts.completeTwoFactor).toBe(1);
    expect(session).toEqual(fake.session);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/login.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/login.js'`.

- [ ] **Step 3: Write `src/cli/login.ts`**

```typescript
import type { EcoleDirecteClient, LoginCredentials, Session } from '../client/types.js';

export interface LoginIO {
  chooseAnswer(question: string, propositions: string[]): Promise<string>;
}

export async function runLoginFlow(
  client: EcoleDirecteClient,
  io: LoginIO,
  credentials: LoginCredentials,
): Promise<Session> {
  const result = await client.login(credentials);
  if ('accessToken' in result) return result;
  const answer = await io.chooseAnswer(result.question, result.propositions);
  return client.completeTwoFactor(result, answer, credentials);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/login.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/login.ts test/cli/login.test.ts
git commit -m "feat: testable login flow with QCM handling"
```

---

## Task 11: `runTool` guard, MCP server + `get_grades` tool (establishes the pattern)

**Context for the implementer:** the MCP server must always be able to
start over stdio, even with no session (never logged in, or a startup
refresh failed — see Task 14). Every tool except `get_auth_status` (which
must keep working specifically to diagnose that situation) needs to (a)
refuse to call the client at all when there's no session, returning a
clear MCP error instead, and (b) turn `AuthenticationRequiredError` and
any other typed `EcoleDirecteApiError` into an actionable `isError` MCP
result instead of an unhandled exception. `runTool` is the shared helper
that does both, used by every tool from here on.

**Files:**
- Create: `src/mcp/runTool.ts`
- Create: `src/mcp/server.ts`
- Create: `src/mcp/tools/getGrades.ts`
- Test: `test/mcp/runTool.test.ts`
- Test: `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `EcoleDirecteClient`, `Session`, `SessionBox`, `createSessionBox`
  (Task 2); `AuthenticationRequiredError`, `EcoleDirecteApiError`,
  `SchoolUnavailableError` (Task 4); `Config` (Task 8);
  `FakeEcoleDirecteClient`, `makeSession` (Task 2).
- Produces: `runTool(sessionBox, fn)` (consumed by every tool task from
  here on, except `get_auth_status`); `ToolContext`,
  `buildServer(context): McpServer`, `registerGetGrades` — `ToolContext`
  and `buildServer` consumed by every tool task and Task 14.

- [ ] **Step 1: Write the failing tests for `runTool`**

```typescript
// test/mcp/runTool.test.ts
import { describe, expect, it } from 'vitest';
import { runTool } from '../../src/mcp/runTool.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { AuthenticationRequiredError, SchoolUnavailableError } from '../../src/client/errors.js';

describe('runTool', () => {
  it('returns a clear error without calling fn when the session box is empty', async () => {
    const box = createSessionBox(null, async () => {});
    let called = false;

    const result = await runTool(box, async () => {
      called = true;
      return { content: [] };
    });

    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('login');
  });

  it('calls fn with the current session when one exists', async () => {
    const box = createSessionBox(makeSession(), async () => {});

    const result = await runTool(box, async (session) => ({
      content: [{ type: 'text', text: session.username }],
    }));

    expect(result.content[0]?.text).toBe('jdupont');
  });

  it('converts AuthenticationRequiredError into an isError result', async () => {
    const box = createSessionBox(makeSession(), async () => {});

    const result = await runTool(box, async () => {
      throw new AuthenticationRequiredError();
    });

    expect(result.isError).toBe(true);
  });

  it('converts a typed EcoleDirecteApiError into an actionable isError result', async () => {
    const box = createSessionBox(makeSession(), async () => {});

    const result = await runTool(box, async () => {
      throw new SchoolUnavailableError(535, 'école fermée');
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('535');
  });

  it('rethrows unrecognized errors', async () => {
    const box = createSessionBox(makeSession(), async () => {});

    await expect(
      runTool(box, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mcp/runTool.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/runTool.js'`.

- [ ] **Step 3: Write `src/mcp/runTool.ts`**

```typescript
import { AuthenticationRequiredError, EcoleDirecteApiError } from '../client/errors.js';
import type { SessionBox } from '../client/sessionBox.js';
import type { Session } from '../client/types.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export async function runTool(
  sessionBox: SessionBox,
  fn: (session: Session) => Promise<ToolResult>,
): Promise<ToolResult> {
  const session = sessionBox.get();
  if (!session) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: "Aucune session École Directe active. Lance `ecoledirecte-mcp login` dans un terminal, puis relance le serveur.",
        },
      ],
    };
  }
  try {
    return await fn(session);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
    if (error instanceof EcoleDirecteApiError) {
      return {
        isError: true,
        content: [{ type: 'text', text: `École Directe a renvoyé une erreur (code ${error.code}) : ${error.message}` }],
      };
    }
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mcp/runTool.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing tests for the `get_grades` tool**

```typescript
// test/mcp/tools.test.ts
import { describe, expect, it } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, type ToolContext } from '../../src/mcp/server.js';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { loadConfig } from '../../src/config.js';

async function connect(context: ToolContext) {
  const server = buildServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new McpClient({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
}

describe('get_grades tool', () => {
  it('returns grades from the underlying client as JSON', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.grades = [
      { id: '1', subject: 'Mathématiques', label: 'Contrôle', value: 14.5, scale: 20, date: '2026-01-15', coefficient: 1, classAverage: 12.3 },
    ];
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({}),
    });

    const result = await mcpClient.callTool({ name: 'get_grades', arguments: {} });

    expect(JSON.parse(textOf(result))).toEqual(fake.grades);
  });

  it('returns a clear MCP error when no session is available, without calling the client', async () => {
    const fake = new FakeEcoleDirecteClient();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => null, set: async () => {} },
      config: loadConfig({}),
    });

    const result = await mcpClient.callTool({ name: 'get_grades', arguments: {} });

    expect(result.isError).toBe(true);
    expect(fake.callCounts.getGrades).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/mcp/tools.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/server.js'`.

- [ ] **Step 7: Write `src/mcp/tools/getGrades.ts`**

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetGrades(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_grades',
    {
      title: 'Notes',
      description: "Récupère les notes de l'élève pour une année scolaire donnée.",
      inputSchema: {
        schoolYear: z.string().optional().describe('Année scolaire, ex: "2025-2026". Par défaut, année courante.'),
      },
    },
    async ({ schoolYear }) =>
      runTool(context.sessionBox, async (session) => {
        const grades = await context.client.getGrades(session, schoolYear);
        return { content: [{ type: 'text', text: JSON.stringify(grades) }] };
      }),
  );
}
```

- [ ] **Step 8: Write `src/mcp/server.ts`**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { EcoleDirecteClient } from '../client/types.js';
import type { SessionBox } from '../client/sessionBox.js';
import { registerGetGrades } from './tools/getGrades.js';

export interface ToolContext {
  client: EcoleDirecteClient;
  sessionBox: SessionBox;
  config: Config;
}

export function buildServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'ecoledirecte-mcp', version: '0.1.0' });
  registerGetGrades(server, context);
  return server;
}
```

Note: `SessionBox` is a plain structural interface (`{ get(): Session | null; set(session): Promise<void> }`), so tests can pass an inline object literal like `{ get: () => session, set: async () => {} }` directly without importing or constructing a real `SessionBox` — TypeScript accepts it structurally.

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/mcp/tools.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add src/mcp/runTool.ts src/mcp/server.ts src/mcp/tools/getGrades.ts test/mcp/runTool.test.ts test/mcp/tools.test.ts
git commit -m "feat: MCP server, runTool no-session guard, get_grades tool"
```

---

## Task 12: Remaining read-only tools

**Files:**
- Create: `src/mcp/tools/getHomework.ts`
- Create: `src/mcp/tools/getTimetable.ts`
- Create: `src/mcp/tools/getSchoolLife.ts`
- Create: `src/mcp/tools/getClassLife.ts`
- Create: `src/mcp/tools/getTimeline.ts`
- Create: `src/mcp/tools/getAuthStatus.ts`
- Modify: `src/mcp/server.ts` (register the six new tools)
- Modify: `test/mcp/tools.test.ts` (add three representative tests)

**Interfaces:**
- Consumes: `ToolContext` (Task 11); `runTool` (Task 11, for every tool
  except `get_auth_status`).
- Produces: six `register*` functions, all wired into `buildServer`.

`get_auth_status` deliberately does **not** use `runTool` — it's the one
tool that must keep working when there's no session at all, since it's
how an agent (or the user) finds out there's no session in the first
place. It calls `context.client.getAuthStatus(context.sessionBox.get())`
directly, which already accepts `Session | null` (Task 2).

- [ ] **Step 1: Add failing tests to `test/mcp/tools.test.ts`** (append below the existing `describe` block)

```typescript
describe('get_homework tool', () => {
  it('passes date range arguments through and returns homework as JSON', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.homework = [{ id: '42', subject: 'Mathématiques', dueDate: '2026-01-12', description: 'Ex 1-5', done: false }];
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({}),
    });

    const result = await mcpClient.callTool({
      name: 'get_homework',
      arguments: { fromDate: '2026-01-01', toDate: '2026-01-31' },
    });

    expect(JSON.parse(textOf(result))).toEqual(fake.homework);
  });
});

describe('get_school_life tool', () => {
  it('returns school life entries as JSON', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.schoolLife = [{ id: '1', type: 'Absence', date: '2026-01-10', description: 'Absence non justifiée', justified: false }];
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({}),
    });

    const result = await mcpClient.callTool({ name: 'get_school_life', arguments: {} });

    expect(JSON.parse(textOf(result))).toEqual(fake.schoolLife);
  });
});

describe('get_auth_status tool', () => {
  it('reports sessionExists: false without erroring when no session is available', async () => {
    const fake = new FakeEcoleDirecteClient();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => null, set: async () => {} },
      config: loadConfig({}),
    });

    const result = await mcpClient.callTool({ name: 'get_auth_status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({ sessionExists: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mcp/tools.test.ts`
Expected: FAIL — unknown tool `get_homework` / `get_school_life` / `get_auth_status`.

- [ ] **Step 3: Write the six tool files**

```typescript
// src/mcp/tools/getHomework.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetHomework(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_homework',
    {
      title: 'Devoirs',
      description:
        "Récupère les devoirs de l'élève entre deux dates (AAAA-MM-JJ). " +
        "Ne couvre que les devoirs à venir (non encore échus) : École Directe ne fournit pas de " +
        "listing en masse des devoirs déjà passés, seulement les devoirs futurs.",
      inputSchema: {
        fromDate: z.string().describe('Date de début, AAAA-MM-JJ'),
        toDate: z.string().describe('Date de fin, AAAA-MM-JJ'),
      },
    },
    async ({ fromDate, toDate }) =>
      runTool(context.sessionBox, async (session) => {
        const homework = await context.client.getHomework(session, fromDate, toDate);
        return { content: [{ type: 'text', text: JSON.stringify(homework) }] };
      }),
  );
}
```

```typescript
// src/mcp/tools/getTimetable.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetTimetable(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_timetable',
    {
      title: 'Emploi du temps',
      description: "Récupère l'emploi du temps de l'élève entre deux dates (AAAA-MM-JJ).",
      inputSchema: {
        fromDate: z.string().describe('Date de début, AAAA-MM-JJ'),
        toDate: z.string().describe('Date de fin, AAAA-MM-JJ'),
      },
    },
    async ({ fromDate, toDate }) =>
      runTool(context.sessionBox, async (session) => {
        const timetable = await context.client.getTimetable(session, fromDate, toDate);
        return { content: [{ type: 'text', text: JSON.stringify(timetable) }] };
      }),
  );
}
```

```typescript
// src/mcp/tools/getSchoolLife.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetSchoolLife(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_school_life',
    {
      title: 'Vie scolaire',
      description: "Récupère les absences, retards, dispenses et sanctions/félicitations de l'élève.",
      inputSchema: {},
    },
    async () =>
      runTool(context.sessionBox, async (session) => {
        const entries = await context.client.getSchoolLife(session);
        return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
      }),
  );
}
```

```typescript
// src/mcp/tools/getClassLife.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetClassLife(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_class_life',
    {
      title: 'Vie de classe',
      description: "Récupère le cahier de texte / vie de la classe de l'élève.",
      inputSchema: {},
    },
    async () =>
      runTool(context.sessionBox, async (session) => {
        const summary = await context.client.getClassLife(session);
        return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
      }),
  );
}
```

```typescript
// src/mcp/tools/getTimeline.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetTimeline(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_timeline',
    {
      title: 'Fil d\'actualité',
      description: "Récupère le fil d'actualité personnel de l'élève (notes, absences, documents...).",
      inputSchema: {},
    },
    async () =>
      runTool(context.sessionBox, async (session) => {
        const timeline = await context.client.getTimeline(session);
        return { content: [{ type: 'text', text: JSON.stringify(timeline) }] };
      }),
  );
}
```

```typescript
// src/mcp/tools/getAuthStatus.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';

export function registerGetAuthStatus(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_auth_status',
    {
      title: 'État de la session',
      description:
        'Diagnostique la session École Directe courante (présence, dernier rafraîchissement) — ' +
        'fonctionne même sans session active, contrairement aux autres outils.',
      inputSchema: {},
    },
    async () => {
      const status = await context.client.getAuthStatus(context.sessionBox.get());
      return { content: [{ type: 'text', text: JSON.stringify(status) }] };
    },
  );
}
```

- [ ] **Step 4: Register the six tools in `src/mcp/server.ts`**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { EcoleDirecteClient } from '../client/types.js';
import type { SessionBox } from '../client/sessionBox.js';
import { registerGetGrades } from './tools/getGrades.js';
import { registerGetHomework } from './tools/getHomework.js';
import { registerGetTimetable } from './tools/getTimetable.js';
import { registerGetSchoolLife } from './tools/getSchoolLife.js';
import { registerGetClassLife } from './tools/getClassLife.js';
import { registerGetTimeline } from './tools/getTimeline.js';
import { registerGetAuthStatus } from './tools/getAuthStatus.js';

export interface ToolContext {
  client: EcoleDirecteClient;
  sessionBox: SessionBox;
  config: Config;
}

export function buildServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'ecoledirecte-mcp', version: '0.1.0' });
  registerGetGrades(server, context);
  registerGetHomework(server, context);
  registerGetTimetable(server, context);
  registerGetSchoolLife(server, context);
  registerGetClassLife(server, context);
  registerGetTimeline(server, context);
  registerGetAuthStatus(server, context);
  return server;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/mcp/tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/getHomework.ts src/mcp/tools/getTimetable.ts src/mcp/tools/getSchoolLife.ts src/mcp/tools/getClassLife.ts src/mcp/tools/getTimeline.ts src/mcp/tools/getAuthStatus.ts src/mcp/server.ts test/mcp/tools.test.ts
git commit -m "feat: remaining read-only MCP tools via runTool, get_auth_status stays reachable without a session"
```

---

## Task 13: Write-capable tools (`mark_homework_done`, `download_document`)

**Files:**
- Create: `src/mcp/tools/markHomeworkDone.ts`
- Create: `src/mcp/tools/downloadDocument.ts`
- Modify: `src/mcp/server.ts`
- Modify: `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `ToolContext`, `runTool` (Task 11); `Config.readOnly` (Task 8).
- Produces: two more `register*` functions wired into `buildServer`.

- [ ] **Step 1: Add failing tests to `test/mcp/tools.test.ts`**

```typescript
describe('mark_homework_done tool', () => {
  it('marks homework done when not read-only', async () => {
    const fake = new FakeEcoleDirecteClient();
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({ READ_ONLY: 'false' }),
    });

    await mcpClient.callTool({ name: 'mark_homework_done', arguments: { homeworkId: '42', done: true } });

    expect(fake.callCounts.markHomeworkDone).toBe(1);
  });

  it('is not registered at all when READ_ONLY is true', async () => {
    const fake = new FakeEcoleDirecteClient();
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({ READ_ONLY: 'true' }),
    });

    const { tools } = await mcpClient.listTools();

    expect(tools.map((t) => t.name)).not.toContain('mark_homework_done');
  });
});

describe('download_document tool', () => {
  it('returns a file path, not inline content', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.downloadResult = { path: '/downloads/123', filename: '123', mimeType: 'application/octet-stream', sizeBytes: 42 };
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({}),
    });

    const result = await mcpClient.callTool({ name: 'download_document', arguments: { fileId: '123', fileType: 'PJ' } });

    expect(JSON.parse(textOf(result))).toEqual(fake.downloadResult);
  });

  it('remains registered even when READ_ONLY is true (it only writes local files)', async () => {
    const fake = new FakeEcoleDirecteClient();
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({ READ_ONLY: 'true' }),
    });

    const { tools } = await mcpClient.listTools();

    expect(tools.map((t) => t.name)).toContain('download_document');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mcp/tools.test.ts`
Expected: FAIL — unknown tools.

- [ ] **Step 3: Write `src/mcp/tools/markHomeworkDone.ts`**

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerMarkHomeworkDone(server: McpServer, context: ToolContext): void {
  if (context.config.readOnly) return;
  server.registerTool(
    'mark_homework_done',
    {
      title: 'Marquer un devoir',
      description: 'Marque un devoir comme fait ou non fait.',
      inputSchema: {
        homeworkId: z.string().describe('Identifiant du devoir'),
        done: z.boolean().default(true),
      },
    },
    async ({ homeworkId, done }) =>
      runTool(context.sessionBox, async (session) => {
        await context.client.markHomeworkDone(session, homeworkId, done);
        return { content: [{ type: 'text', text: `Devoir ${homeworkId} marqué comme ${done ? 'fait' : 'non fait'}.` }] };
      }),
  );
}
```

- [ ] **Step 4: Write `src/mcp/tools/downloadDocument.ts`**

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerDownloadDocument(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'download_document',
    {
      title: 'Télécharger un document',
      description:
        "Télécharge un document (bulletin, pièce jointe...) depuis École Directe et l'enregistre sur disque. Renvoie le chemin du fichier, pas son contenu.",
      inputSchema: {
        fileId: z.string().describe('Identifiant du fichier École Directe'),
        fileType: z.string().describe('Type de fichier École Directe (ex: "PJ", "CDT")'),
      },
    },
    async ({ fileId, fileType }) =>
      runTool(context.sessionBox, async (session) => {
        const result = await context.client.downloadDocument(session, fileId, fileType, context.config.downloadDir);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }),
  );
}
```

- [ ] **Step 5: Register both in `src/mcp/server.ts`** (add imports and two calls in `buildServer`)

```typescript
import { registerMarkHomeworkDone } from './tools/markHomeworkDone.js';
import { registerDownloadDocument } from './tools/downloadDocument.js';

// inside buildServer, after the existing registrations:
  registerMarkHomeworkDone(server, context);
  registerDownloadDocument(server, context);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/mcp/tools.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/markHomeworkDone.ts src/mcp/tools/downloadDocument.ts src/mcp/server.ts test/mcp/tools.test.ts
git commit -m "feat: mark_homework_done and download_document tools with read-only gating"
```

---

## Task 14: stdio transport + CLI wiring

**Context for the implementer:** the stdio MCP server must always start,
even when there's no session yet (fresh install) or the session on disk
can no longer be refreshed (revoked, corrupted). Getting this wrong would
make `get_auth_status` — the one tool meant to diagnose exactly that
situation — itself unreachable, which is worse than not having it at
all. So `runServeCommand` below never calls `process.exit` on a missing
or unrefreshable session; it logs a warning to stderr (safe — stdio MCP
traffic is stdout/stdin only) and starts the server with whatever session
state it has (possibly `null`).

**Files:**
- Create: `src/transport/stdio.ts`
- Create: `src/cli/index.ts`
- Modify: `package.json` (none — `bin` already set in Task 1)

**Interfaces:**
- Consumes: `buildServer` (Task 11/12/13); `createClient` (Task 9); `createSessionBox` (Task 2);
  `createBlocksDirecteClient` (Task 6); `loadConfig` (Task 8); `runLoginFlow` (Task 10);
  `readSession`, `writeSession`, `loadOrCreateDeviceUUID`, `resolveSessionPath` (Task 3).

This task is glue code wiring real stdin/stdout/process — verified
manually (Step 4 below), not by an automated test.

- [ ] **Step 1: Write `src/transport/stdio.ts`**

```typescript
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../mcp/server.js';
import type { ToolContext } from '../mcp/server.js';

export async function startStdioServer(context: ToolContext): Promise<void> {
  const server = buildServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 2: Write `src/cli/index.ts`**

```typescript
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createBlocksDirecteClient } from '../client/blocksDirecteAdapter.js';
import { createClient } from '../client/createClient.js';
import { createSessionBox } from '../client/sessionBox.js';
import { loadConfig } from '../config.js';
import { loadOrCreateDeviceUUID, readSession, resolveSessionPath, writeSession } from '../store/sessionStore.js';
import { runLoginFlow, type LoginIO } from './login.js';
import { startStdioServer } from '../transport/stdio.js';

async function promptVisible(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(question);
    let buffer = '';
    const onData = (char: Buffer) => {
      const c = char.toString('utf8');
      if (c === '\n' || c === '\r' || c === '\u0004') {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(buffer);
        return;
      }
      if (c === '\u0003') process.exit(1);
      if (c === '\u007f') {
        buffer = buffer.slice(0, -1);
        return;
      }
      buffer += c;
    };
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on('data', onData);
  });
}

const readlineIO: LoginIO = {
  async chooseAnswer(question, propositions) {
    console.log(`\nQuestion de sécurité École Directe :\n${question}\n`);
    propositions.forEach((p, i) => console.log(`  ${i + 1}) ${p}`));
    const raw = await promptVisible('\nVotre réponse (numéro) : ');
    const index = Number.parseInt(raw, 10) - 1;
    return propositions[index] ?? raw;
  },
};

async function runLoginCommand(): Promise<void> {
  const username = await promptVisible('Identifiant École Directe : ');
  const password = await promptHidden('Mot de passe : ');
  const deviceUUID = await loadOrCreateDeviceUUID();
  const client = createBlocksDirecteClient();
  const session = await runLoginFlow(client, readlineIO, { username, password, deviceUUID });
  await writeSession(session);
  console.log(`\nConnecté en tant que ${session.displayName}. Session enregistrée dans ${resolveSessionPath()}.`);
}

async function runServeCommand(useHttp: boolean): Promise<void> {
  if (useHttp) {
    console.error('Le transport HTTP arrive en V2. Utilise `ecoledirecte-mcp serve` (stdio) pour l\'instant.');
    process.exit(1);
  }
  const config = loadConfig();
  const diskSession = await readSession(config.sessionPath);
  const base = createBlocksDirecteClient();

  let initialSession = diskSession;
  if (diskSession) {
    try {
      const refreshed = await base.refreshSession(diskSession);
      await writeSession(refreshed, config.sessionPath);
      initialSession = refreshed;
    } catch (error) {
      console.error(
        `Avertissement : impossible de rafraîchir la session au démarrage (${(error as Error).message}). ` +
          'Le serveur démarre quand même ; `get_auth_status` permet de diagnostiquer, et les autres outils ' +
          'retenteront un rafraîchissement à la demande.',
      );
    }
  } else {
    console.error(
      "Aucune session trouvée. `get_auth_status` le signalera. Lance `ecoledirecte-mcp login` dans un autre terminal pour t'authentifier.",
    );
  }

  const sessionBox = createSessionBox(initialSession, (session) => writeSession(session, config.sessionPath));
  const client = createClient(base, sessionBox, { sessionMaxAgeMs: config.sessionMaxAgeMs });
  await startStdioServer({ client, sessionBox, config });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      http: { type: 'boolean', default: false },
      'read-only': { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values['read-only'] !== undefined) {
    process.env.READ_ONLY = String(values['read-only']);
  }
  if (command === 'login') {
    await runLoginCommand();
  } else if (command === 'serve') {
    await runServeCommand(Boolean(values.http));
  } else {
    console.error('Usage: ecoledirecte-mcp <login|serve> [--http] [--read-only]');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 3: Build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: both succeed; `dist/cli/index.js` is created with the shebang
preserved as its first line.

- [ ] **Step 4: Manual verification**

First, confirm the server starts even with no session at all: temporarily
rename `~/.config/ecoledirecte-mcp` out of the way if it exists, then run
`node dist/cli/index.js serve`. Expected: a warning on stderr
("Aucune session trouvée...") but the process **stays running** (doesn't
exit) — connect an MCP client (or Ctrl+C once satisfied) and confirm
`get_auth_status` is callable and returns `{"sessionExists": false, ...}`
while every other tool call returns a clear `isError` result instead of
crashing the server.

Then run the real flow: `node dist/cli/index.js login`.
Expected: prompts for identifiant/mot de passe, shows the QCM question
with numbered choices, then confirms the session was saved to
`~/.config/ecoledirecte-mcp/session.json` (requires the user's real École
Directe credentials — this is the first point where a real account is
needed).

Then add the server to Claude Code:
`claude mcp add ecoledirecte -- node /absolute/path/to/dist/cli/index.js serve`
Expected: `claude mcp list` shows it connected; all 9 tools (`get_grades`,
`get_homework`, `get_timetable`, `get_school_life`, `get_class_life`,
`get_timeline`, `get_auth_status`, `mark_homework_done`,
`download_document` — everything except the deferred `get_messages`) are
visible and callable.

- [ ] **Step 5: Commit**

```bash
git add src/transport/stdio.ts src/cli/index.ts
git commit -m "feat: stdio transport and CLI wiring (login, serve)"
```

---

## Task 15: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
```

`typecheck` runs before `build` deliberately: it's what actually
type-checks `test/` and `scripts/` (Task 1's `tsconfig.test.json`) —
`build` only compiles `src/`, so without this step, the
`Awaited<ReturnType<...>>` types derived from `@blockshub/blocksdirecte`
in the fixtures/adapter would never get re-checked in CI.

- [ ] **Step 2: Verify locally**

Run: `npm ci && npm run typecheck && npm run build && npm test`
Expected: all succeed — this is exactly what CI will run.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build and test workflow"
```

---

## Task 16: Smoke test script + README

**Files:**
- Create: `scripts/smoke-test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `createBlocksDirecteClient` (Task 6), `createSessionBox`, `createClient` (Task 9),
  `readSession`, `writeSession`, `resolveSessionPath` (Task 3).

- [ ] **Step 1: Write `scripts/smoke-test.ts`**

```typescript
import { createBlocksDirecteClient } from '../src/client/blocksDirecteAdapter.js';
import { createClient } from '../src/client/createClient.js';
import { createSessionBox } from '../src/client/sessionBox.js';
import { loadConfig } from '../src/config.js';
import { readSession, resolveSessionPath, writeSession } from '../src/store/sessionStore.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const session = await readSession();
  if (!session) throw new Error('Run `ecoledirecte-mcp login` first.');

  const base = createBlocksDirecteClient();
  const refreshed = await base.refreshSession(session);
  await writeSession(refreshed);
  const sessionBox = createSessionBox(refreshed, (s) => writeSession(s));
  const client = createClient(base, sessionBox, { sessionMaxAgeMs: config.sessionMaxAgeMs });
  // sessionBox was just seeded with `refreshed` (non-null) above, and nothing in
  // this single-shot script can clear it — safe to assert non-null on every read.
  const currentSession = () => sessionBox.get()!;

  console.log('getAuthStatus:', await client.getAuthStatus(currentSession()));
  console.log('getGrades:', (await client.getGrades(currentSession())).slice(0, 3));

  const today = new Date().toISOString().slice(0, 10);
  const in14Days = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  console.log('getHomework:', (await client.getHomework(currentSession(), today, in14Days)).slice(0, 3));
  console.log('getTimetable:', (await client.getTimetable(currentSession(), today, in14Days)).slice(0, 3));
  console.log('getSchoolLife:', (await client.getSchoolLife(currentSession())).slice(0, 3));
  console.log('getClassLife:', await client.getClassLife(currentSession()));
  console.log('getTimeline:', (await client.getTimeline(currentSession())).slice(0, 3));

  console.log(`\nSession path: ${resolveSessionPath()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Write `README.md`**

```markdown
# ecoledirecte-mcp

Serveur MCP personnel pour École Directe (notes, devoirs, emploi du
temps, vie scolaire, vie de classe, fil d'actualité, documents).

## Installation locale (V1 — stdio uniquement)

    npm install
    npm run build
    node dist/cli/index.js login

`login` demande l'identifiant/mot de passe École Directe, puis, à la
première connexion depuis cette machine, une question de sécurité (QCM)
— c'est obligatoire côté École Directe, il n'y a pas de contournement.
La session est enregistrée dans `~/.config/ecoledirecte-mcp/session.json`
(permissions 600) et sera rafraîchie automatiquement ensuite.

## Utilisation avec Claude Code

    claude mcp add ecoledirecte -- node /chemin/absolu/vers/dist/cli/index.js serve

## Variables d'environnement

- `SESSION_PATH` — chemin du fichier de session (défaut `~/.config/ecoledirecte-mcp/session.json`)
- `DOWNLOAD_DIR` — dossier de téléchargement des documents (défaut `~/.local/share/ecoledirecte-mcp/downloads`)
- `READ_ONLY` — `true` pour désactiver `mark_homework_done` (défaut `false` en local)

Le `deviceUUID` généré au premier `login` est stocké séparément, dans
`~/.config/ecoledirecte-mcp/device-id` (à côté de `session.json`) — ne
pas le supprimer entre deux logins, sous peine de redéclencher le QCM à
chaque fois.

## Limitations connues (V1)

**Expiration de session en cours d'utilisation.** Le serveur rafraîchit
la session de façon préventive si elle a plus de `SESSION_MAX_AGE_MS`
(15 minutes par défaut) sans avoir été rafraîchie, et détecte aussi
certains signes d'expiration sur les appels de lecture (réponse vide là
où École Directe en garantit normalement une) pour déclencher un
rafraîchissement + une nouvelle tentative — un seul essai, jamais de
boucle. Mais la librairie `@blockshub/blocksdirecte` ne remonte pas
toujours un code d'erreur exploitable pour les appels de données (notes,
devoirs, emploi du temps, etc.) : seuls les appels d'authentification le
font. Si aucun des deux mécanismes ci-dessus ne suffit (par exemple une
écriture comme `mark_homework_done`, dont la réponse ne contient rien à
inspecter), un outil peut renvoyer une erreur d'authentification claire
au lieu de réussir automatiquement : relance `ecoledirecte-mcp login`
dans ce cas.

## Statut

V1 : usage local uniquement (transport stdio). Le transport HTTP
(hébergement Docker sur le VPS, accessible via Tailscale) et un tool de
messagerie sont prévus pour une V2 séparée.

## Développement

    npm test              # tests unitaires (aucun appel réseau réel)
    npm run smoke-test     # vérification manuelle contre un vrai compte
```

- [ ] **Step 3: Run the smoke test manually** (requires the user's real École Directe credentials, already saved via `login` in Task 14)

Run: `npm run smoke-test` (this runs `tsx --env-file=.env scripts/smoke-test.ts`
per Task 1's `package.json`; if the installed `tsx` doesn't forward
`--env-file` to Node, fall back to
`node --env-file=.env --import tsx scripts/smoke-test.ts`).
Expected: each tool prints real data from the user's account without
throwing. Compare the shapes against `src/client/types.ts` — this is
where the "points to verify against a real account" from the spec get
resolved for real. Note any mismatches for a quick follow-up fix.

- [ ] **Step 4: Verify the `wrapCall`/`mapErrorCode` guess against a real expired token**

`extractErrorCode` guesses that a failed BlocksDirecte *auth* call
(login/refresh/2FA — the only ones that actually check École Directe's
numeric `code`, confirmed by reading the library's source during Task
6's Amendment) carries that code as a `.code` or `.response.code`
property on the thrown value. To check this for real: edit
`~/.config/ecoledirecte-mcp/session.json`, corrupt `accessToken` to an
obviously invalid string, then run `npm run smoke-test` again.

Expected: the call should trigger `withAutoRefresh`'s retry path — you'll
see it succeed anyway (after a silent refresh) because `refreshSession`
doesn't depend on the corrupted `accessToken` alone (it also carries
`cnKey`/`cvKey`/`deviceUUID`). If it instead throws an unhandled/raw
error, `extractErrorCode`'s heuristic doesn't match what
`AuthModules.refreshToken` actually throws — inspect the real error
object (add a temporary `console.error(error)` in `wrapCall`) and adjust
`extractErrorCode` in `src/client/errors.ts` accordingly, then re-run the
Task 4 tests.

- [ ] **Step 5: Calibrate `SESSION_MAX_AGE_MS` against the real token lifetime**

The 15-minute default (Task 8) is a conservative guess — nothing in
École Directe's documentation states the real token TTL. Over normal use
across a few days, call `get_auth_status` periodically (or watch its
`lastRefreshAt`) and note how long a session actually stays valid before
a data call starts needing the reactive-retry path (i.e. before
`PossiblyExpiredSessionError` starts firing — add a temporary
`console.error` in `assertPresent`, Task 6's Amendment, to notice this
without digging through logs). Once the real lifetime is known, update
the default in `src/config.ts`'s `DEFAULT_SESSION_MAX_AGE_MS` (and this
README's env var table) to something comfortably under it — e.g. half
the observed TTL — rather than leaving the untested 15-minute guess as
the shipped default.

- [ ] **Step 6: Confirm the null/undefined assumption behind `PossiblyExpiredSessionError`**

Task 6's Amendment assumes an expired token makes BlocksDirecte's data
methods (`getMark`, `getUpcomingHomework`, `getHomeworksForDate`,
`getTimetableBetweenDates`, `getSchoolLife`, `getClassLife`,
`getPersonalTimeline`) return `null`/`undefined` rather than an empty
object/array/string, or a differently-shaped error payload — this is
inferred from reading the library's source, not yet observed against a
real expired token. To check: with a corrupted/expired session (as in
Step 4, but this time let `SESSION_MAX_AGE_MS` be large enough that the
*preventive* refresh doesn't mask it, e.g. temporarily set
`SESSION_MAX_AGE_MS` very high via `.env`), call each of the 7 guarded
methods and confirm `assertPresent` actually throws
`PossiblyExpiredSessionError` (temporarily log inside `assertPresent`
before it throws, or catch the tool's `isError` result and check the
message). If any method instead returns something *not* null/undefined
on an expired token (an empty array, an empty object, a string), the
guard silently won't fire for that method — note which one(s) and adjust
`assertPresent`'s check (or that method's specific handling) in
`src/client/blocksDirecteAdapter.ts` accordingly, then re-verify.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-test.ts README.md
git commit -m "docs: README and manual smoke-test script"
```

---

## Deferred / not in this plan

- **`get_messages` tool / `src/client/messaging.ts`**: explicitly excluded
  per the spec's own instruction not to write this code before verifying
  the real request contract. Before starting it: get the location of the
  user's "Mon ÉcoleDirecte" Electron app source (local path or repo),
  read its auth/messaging request code, and cross-check against
  `ecoledirecte-api-docs`'s `/v3/eleves/{id}/messages/{id}.awp` section.
  Then it's a small follow-up task: one pure mapper (if the response
  needs base64 decoding) plus one adapter method plus one tool,
  following the exact same pattern as Tasks 5/6/12.
- **V2** (HTTP transport on the VPS's Tailscale interface, Docker image
  for ARM64, `crypto.timingSafeEqual` bearer check, DNS rebinding
  protection, `/health` route): separate plan, written after V1 is
  verified end-to-end via the smoke test.

## Points to verify once Task 16's smoke test runs against a real account

- `extractErrorCode`'s heuristic for reading a numeric error code off a
  raw error thrown by an *auth* call (login/refresh/2FA — the only
  BlocksDirecte methods that actually check École Directe's `code` field,
  confirmed by reading the library's source in Task 6's Amendment) —
  covered by Task 16 Step 4.
- **Whether an expired token really makes BlocksDirecte's data methods
  return `null`/`undefined`** (not an empty array/object/string, and not
  a differently-shaped error payload) — the entire
  `PossiblyExpiredSessionError` strategy (Task 4's and Task 6's
  Amendments) depends on this exact behavior, inferred from reading the
  library's source but not yet observed against a real expired token —
  covered by Task 16 Step 6.
- **The real `SESSION_MAX_AGE_MS` value** — 15 minutes (Task 8's default)
  is an untested guess; calibrate it against the real observed token
  lifetime — covered by Task 16 Step 5.
- Real shape of `getSchoolLife`/`getClassLife`/`getTimeline` responses —
  the mappers in Task 5 are typed against the library's `.d.ts` (verified
  by inspecting the package tarball during planning) but not yet
  exercised against live data.
- Whether `AuthModules.refreshToken` truly needs `cnKey`/`cvKey` on every
  refresh or just the `accessToken` + `deviceUUID` — confirm from actual
  refresh responses.
- Whether `fileType` values needed by `downloadDocument` are reliably
  available wherever a document is referenced elsewhere (e.g. in
  `getClassLife`'s `fichiers` or homework attachments) — may need a
  small DTO addition later to carry `fileType` alongside document IDs.
