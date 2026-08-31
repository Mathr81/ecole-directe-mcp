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
