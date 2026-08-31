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

    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(fake.homework);
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
