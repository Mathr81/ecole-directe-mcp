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
    expect(config).toMatchObject({
      sessionPath: '/tmp/s.json',
      downloadDir: '/tmp/dl',
      readOnly: true,
      sessionMaxAgeMs: 600000,
    });
  });

  describe('HTTP settings', () => {
    it('binds loopback and carries no token by default', () => {
      // Not 0.0.0.0: on the VPS the bind address is set to the Tailscale
      // interface, and a wide-open default would publish the server the first
      // time someone forgot to set it. An empty token makes the HTTP
      // transport refuse to start.
      const { http } = loadConfig({});

      expect(http.host).toBe('127.0.0.1');
      expect(http.port).toBe(8787);
      expect(http.authToken).toBe('');
    });

    it('allowlists the bound address when MCP_ALLOWED_HOSTS is unset', () => {
      const { http } = loadConfig({ MCP_HTTP_HOST: '100.64.0.5', MCP_HTTP_PORT: '9000' });

      expect(http.allowedHosts).toEqual(['100.64.0.5:9000', '100.64.0.5']);
    });

    it('takes an explicit allowlist over the derived one', () => {
      const { http } = loadConfig({ MCP_ALLOWED_HOSTS: 'vps.tailnet.ts.net:8787, 100.64.0.5:8787' });

      expect(http.allowedHosts).toEqual(['vps.tailnet.ts.net:8787', '100.64.0.5:8787']);
    });

    it('reads the token from the environment', () => {
      expect(loadConfig({ MCP_AUTH_TOKEN: 'secret' }).http.authToken).toBe('secret');
    });
  });

  describe('read-only default per transport', () => {
    it('is false for stdio and true for HTTP', () => {
      // stdio's only caller is the user at their own keyboard; HTTP is
      // reachable from other machines on the tailnet.
      expect(loadConfig({}, { readOnlyDefault: false }).readOnly).toBe(false);
      expect(loadConfig({}, { readOnlyDefault: true }).readOnly).toBe(true);
    });

    it('lets an explicit READ_ONLY win over the transport default', () => {
      expect(loadConfig({ READ_ONLY: 'false' }, { readOnlyDefault: true }).readOnly).toBe(false);
      expect(loadConfig({ READ_ONLY: 'true' }, { readOnlyDefault: false }).readOnly).toBe(true);
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
