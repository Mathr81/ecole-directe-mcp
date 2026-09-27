import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('server identity', () => {
  it('advertises a title and an icon in serverInfo, as data URIs need no fetch', async () => {
    // Claude.ai does not read serverInfo.icons for custom connectors yet
    // (anthropics/claude-ai-mcp#152) and shows the favicon of the domain's
    // last two labels instead; the icon is there for when it does.
    const session = makeSession();
    const mcpClient = await connect({
      client: new FakeEcoleDirecteClient(),
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({}),
    });

    const info = mcpClient.getServerVersion();

    expect(info?.title).toBe('École Directe');
    expect(info?.icons?.[0]).toMatchObject({ mimeType: 'image/svg+xml', sizes: ['any'] });
    expect(info?.icons?.[0].src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(info!.icons![0].src.split(',')[1], 'base64').toString('utf8');
    expect(svg).toContain('<svg');
  });
});

describe('get_grades tool', () => {
  it('returns grades from the underlying client as JSON', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.grades = [
      { id: '1', subject: 'Mathématiques', label: 'Contrôle', value: 14.5, scale: 20, date: '2026-01-15', coefficient: 1, classAverage: 12.3, status: null, significant: true, subjectCode: 'MATHS', period: '', periodCode: 'A001', type: '', classMin: null, classMax: null },
    ];
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({}),
    });

    const result = await mcpClient.callTool({ name: 'get_grades', arguments: {} });

    // `callTool`'s return type in this SDK version is a union that also
    // covers task-based tool execution (a branch with no `content` field,
    // only `toolResult`), which `get_grades` never uses — this cast bridges
    // that union down to the plain-result shape `textOf` expects. See the
    // Task 11 report for details.
    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(fake.grades);
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

describe('get_homework tool', () => {
  it('passes date range arguments through and returns homework as JSON', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.homework = {
      homework: [
        {
          id: '42',
          subject: 'Mathématiques',
          teacher: 'M. Martin',
          dueDate: '2026-01-12',
          givenOn: '2026-01-05',
          description: 'Ex 1-5',
          done: false,
          isTest: false,
          lessonContent: null,
          attachments: [],
        },
      ],
      lessons: [],
    };
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

    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(fake.homework);
  });
});

describe('get_averages tool', () => {
  it('returns the computed averages for the requested year', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.averages = [
      {
        code: 'A001',
        label: '1er Semestre',
        start: '2026-09-01',
        end: '2027-01-15',
        closed: false,
        annual: false,
        overall: 14,
        officialOverall: null,
        subjects: [
          { code: 'MATHS', subject: 'MATHEMATIQUES', coefficient: 1, average: 14, classAverageEstimate: 11, gradeCount: 2, officialAverage: null },
        ],
      },
    ];
    const session = makeSession();
    const mcpClient = await connect({ client: fake, sessionBox: { get: () => session, set: async () => {} }, config: loadConfig({}) });

    const result = await mcpClient.callTool({ name: 'get_averages', arguments: { schoolYear: '2025-2026' } });

    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(fake.averages);
    expect(fake.lastArgs.getAverages).toEqual(['2025-2026']);
  });
});

describe('get_documents tool', () => {
  it('lists documents for the requested year', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.documents = [
      { id: '10339', category: 'bulletin', label: 'Bulletin 2ème Semestre', date: '2026-06-04', fileType: 'Note', schoolYear: '2025-2026' },
    ];
    const session = makeSession();
    const mcpClient = await connect({ client: fake, sessionBox: { get: () => session, set: async () => {} }, config: loadConfig({}) });

    const result = await mcpClient.callTool({ name: 'get_documents', arguments: { schoolYear: '2025-2026' } });

    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(fake.documents);
    expect(fake.lastArgs.getDocuments).toEqual(['2025-2026']);
  });
});

describe('date range validation', () => {
  // A malformed date used to come back as `[]`, which an LLM reads as "no
  // homework" rather than "you called me wrong".
  async function call(name: string, fromDate: string, toDate: string) {
    const fake = new FakeEcoleDirecteClient();
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({}),
    });
    const result = await mcpClient.callTool({ name, arguments: { fromDate, toDate } });
    return { fake, result, text: textOf(result as { content: unknown }) };
  }

  for (const name of ['get_homework', 'get_timetable']) {
    it(`${name} rejects a date that is not AAAA-MM-JJ, without calling École Directe`, async () => {
      const { fake, result, text } = await call(name, '2026-09-01', 'hier');

      expect(result.isError).toBe(true);
      expect(text).toContain('AAAA-MM-JJ');
      expect(Object.keys(fake.callCounts)).toEqual([]);
    });

    it(`${name} rejects a well-formed but impossible date`, async () => {
      const { result } = await call(name, '2026-13-45', '2026-12-31');

      expect(result.isError).toBe(true);
    });

    it(`${name} rejects a range that ends before it starts`, async () => {
      const { result, text } = await call(name, '2026-10-01', '2026-09-01');

      expect(result.isError).toBe(true);
      expect(text).toContain('fromDate');
    });
  }
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

    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(fake.schoolLife);
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
    expect(JSON.parse(textOf(result as { content: unknown }))).toMatchObject({ sessionExists: false });
  });
});

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
  async function download(fake: FakeEcoleDirecteClient, extra: Partial<ToolContext> = {}) {
    const session = makeSession();
    const mcpClient = await connect({
      client: fake,
      sessionBox: { get: () => session, set: async () => {} },
      config: loadConfig({}),
      ...extra,
    });
    const result = await mcpClient.callTool({ name: 'download_document', arguments: { fileId: '123', fileType: 'PJ' } });
    return JSON.parse(textOf(result as { content: unknown })) as Record<string, unknown>;
  }

  it('returns the local path and the extracted text, with no link, over stdio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ed-tool-'));
    try {
      const path = join(dir, 'circulaire.txt');
      await writeFile(path, 'Sortie au musée jeudi.');
      const fake = new FakeEcoleDirecteClient();
      fake.downloadResult = { path, filename: 'circulaire.txt', mimeType: 'text/plain', sizeBytes: 23 };

      const payload = await download(fake);

      expect(payload).toMatchObject({ path, filename: 'circulaire.txt', text: 'Sortie au musée jeudi.', textTruncated: false });
      expect(payload.downloadUrl).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes the school year through, for archived documents', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.downloadResult = { path: '/downloads/Note_A002.pdf', filename: 'Note_A002.pdf', mimeType: 'image/png', sizeBytes: 1 };
    const session = makeSession();
    const mcpClient = await connect({ client: fake, sessionBox: { get: () => session, set: async () => {} }, config: loadConfig({}) });

    await mcpClient.callTool({
      name: 'download_document',
      arguments: { fileId: '10339', fileType: 'Note', schoolYear: '2025-2026' },
    });

    expect(fake.lastArgs.downloadDocument?.[0]).toBe('10339');
    expect(fake.lastArgs.downloadDocument?.[1]).toBe('Note');
    expect(fake.lastArgs.downloadDocument?.[3]).toBe('2025-2026');
  });

  it('says why there is no text for a format it cannot read', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.downloadResult = { path: '/downloads/123', filename: 'photo.png', mimeType: 'image/png', sizeBytes: 42 };

    const payload = await download(fake);

    expect(payload.text).toBeNull();
    expect(payload.textUnavailableReason).toContain('image/png');
  });

  it('swaps the server path for a download link when the transport issues links', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.downloadResult = { path: '/data/downloads/b.pdf', filename: 'b.pdf', mimeType: 'image/png', sizeBytes: 42 };
    const issued: unknown[] = [];

    const payload = await download(fake, {
      downloadLinks: {
        issue: (file) => {
          issued.push(file);
          return { url: 'https://ed.example.fr/downloads/tok', expiresAt: '2026-09-27T15:00:00.000Z' };
        },
      },
    });

    expect(issued).toEqual([{ path: '/data/downloads/b.pdf', filename: 'b.pdf', mimeType: 'image/png' }]);
    expect(payload).toMatchObject({
      filename: 'b.pdf',
      downloadUrl: 'https://ed.example.fr/downloads/tok',
      downloadUrlExpiresAt: '2026-09-27T15:00:00.000Z',
    });
    expect(payload.path).toBeUndefined();
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
