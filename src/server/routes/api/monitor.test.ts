import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('monitor routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-monitor-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./monitor.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.monitorRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rejects malformed monitor config payloads at the route boundary', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: {
        ldohCookie: 123,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid ldohCookie. Expected string or null.',
    });
  });

  it('accepts null monitor cookie payloads and clears the stored cookie', async () => {
    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: {
        ldohCookie: 'ld_auth_session=abcdefghijklmnopqrstuvwxyz',
      },
    });
    expect(saveResponse.statusCode).toBe(200);

    const clearResponse = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: {
        ldohCookie: null,
      },
    });

    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toMatchObject({
      success: true,
      ldohCookieConfigured: false,
    });

    const saved = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'monitor_ldoh_cookie'))
      .get();
    expect(saved?.value).toBe('""');
  });

  it('lists realtime model monitor candidates with cheap API key models first', async () => {
    const [site] = await db.insert(schema.sites).values({
      name: 'Sub2API',
      url: 'https://sub2api.example',
      platform: 'sub2api',
      status: 'active',
    }).returning();
    const [account] = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'tester',
      accessToken: 'session-token',
      status: 'active',
    }).returning();
    const [token] = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'cheap-key',
      token: 'sk-test',
      enabled: true,
      valueStatus: 'ready',
    }).returning();
    await db.insert(schema.tokenModelAvailability).values([
      {
        tokenId: token.id,
        modelName: 'gpt-4.5-preview',
        available: true,
        latencyMs: 1200,
      },
      {
        tokenId: token.id,
        modelName: 'gemini-2.5-flash-lite',
        available: true,
        latencyMs: 900,
      },
      {
        tokenId: token.id,
        modelName: 'text-embedding-3-small',
        available: true,
        latencyMs: 100,
      },
      {
        tokenId: token.id,
        modelName: 'gpt-image-1-mini',
        available: true,
        latencyMs: 100,
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/monitor/models',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      candidates: Array<{ id: string; modelName: string; kind: string; recommended: boolean }>;
      recommended: Array<{ modelName: string }>;
    };
    expect(body.candidates.map((candidate) => candidate.modelName)).toEqual([
      'gemini-2.5-flash-lite',
      'gpt-4.5-preview',
    ]);
    expect(body.candidates[0]).toMatchObject({
      kind: 'token',
      recommended: true,
    });
    expect(body.recommended[0]?.modelName).toBe('gemini-2.5-flash-lite');
  });
});
