import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasKv, hasLiveLlm, kvCredentials, resetEnvCache } from '@/lib/config/env';

/**
 * The deployment contract. These names come from whichever storage product is
 * attached on Vercel, so getting them wrong surfaces only in production --
 * which is exactly why they are pinned here.
 */
const ORIGINAL = { ...process.env };

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of [
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'ANTHROPIC_API_KEY',
    'USE_MOCK_LLM',
  ]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  resetEnvCache();
}

beforeEach(() => resetEnvCache());

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

describe('kvCredentials', () => {
  it('reads the Vercel KV naming', () => {
    setEnv({ KV_REST_API_URL: 'https://example.upstash.io', KV_REST_API_TOKEN: 'tok-a' });

    expect(kvCredentials()).toEqual({ url: 'https://example.upstash.io', token: 'tok-a' });
    expect(hasKv()).toBe(true);
  });

  it('reads the Upstash marketplace naming', () => {
    setEnv({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'tok-b',
    });

    expect(kvCredentials()).toEqual({ url: 'https://example.upstash.io', token: 'tok-b' });
    expect(hasKv()).toBe(true);
  });

  it('prefers the Vercel naming when both are present', () => {
    setEnv({
      KV_REST_API_URL: 'https://vercel.upstash.io',
      KV_REST_API_TOKEN: 'tok-a',
      UPSTASH_REDIS_REST_URL: 'https://upstash.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'tok-b',
    });

    expect(kvCredentials()?.token).toBe('tok-a');
  });

  it('falls back to in-process storage when only half a pair is set', () => {
    setEnv({ KV_REST_API_URL: 'https://example.upstash.io' });

    expect(kvCredentials()).toBeNull();
    expect(hasKv()).toBe(false);
  });

  it('reports no KV when nothing is configured', () => {
    setEnv({});
    expect(hasKv()).toBe(false);
  });
});

describe('hasLiveLlm', () => {
  it('is true only with a key and mocking off', () => {
    setEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(hasLiveLlm()).toBe(true);
  });

  it('is false when the key is missing, so the app degrades to the mock', () => {
    setEnv({});
    expect(hasLiveLlm()).toBe(false);
  });

  it('is false when mocking is explicitly on, even with a key', () => {
    setEnv({ ANTHROPIC_API_KEY: 'sk-test', USE_MOCK_LLM: 'true' });
    expect(hasLiveLlm()).toBe(false);
  });
});

describe('malformed KV configuration', () => {
  it('degrades to the in-process store instead of failing the whole env parse', () => {
    // A broken optional dependency must not take every route down with it.
    setEnv({ KV_REST_API_URL: 'not-a-url', KV_REST_API_TOKEN: 'tok' });

    expect(() => hasKv()).not.toThrow();
    expect(hasKv()).toBe(false);
  });

  it('still reads a valid Upstash pair when the KV pair is malformed', () => {
    setEnv({
      KV_REST_API_URL: 'not-a-url',
      KV_REST_API_TOKEN: 'tok-a',
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'tok-b',
    });

    expect(kvCredentials()?.token).toBe('tok-b');
  });
});
