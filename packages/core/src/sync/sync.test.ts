import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { syncArchive } from './upload';
import { remoteRequest, validateEndpoint, type RemoteConfig } from './client';
import { snapshotHash, snapshotKey, type Snapshot } from './protocol';

test('remote credentials cannot follow redirects or use unapproved HTTP endpoints', async () => {
  for (const url of ['http://example.com', 'file:///tmp', 'https://user:secret@example.com', 'https://example.com?q=1'])
    expect(() => validateEndpoint(url)).toThrow();
  expect(validateEndpoint('https://example.com/')).toBe('https://example.com');
  expect(validateEndpoint('http://192.168.1.2', true)).toBe('http://192.168.1.2');
  let forwarded = false;
  const target = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      forwarded = true;
      return Response.json({});
    },
  });
  const source = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.redirect(target.url.toString(), 307),
  });
  try {
    await expect(
      remoteRequest({ endpoint: source.url.toString(), token: 'fixture', allowHttp: false }, '/v1/me'),
    ).rejects.toThrow();
    expect(forwarded).toBe(false);
  } finally {
    await source.stop(true);
    await target.stop(true);
  }
});

test('sync retains pending uploads, detects archive changes, restores remote data and excludes concurrent senders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-upload-'));
  const previousData = process.env.SESSIONS_DATA_DIR,
    previousArchive = process.env.SESSIONS_ARCHIVE_DIR;
  process.env.SESSIONS_DATA_DIR = join(root, 'data');
  process.env.SESSIONS_ARCHIVE_DIR = join(root, 'archive');
  const inventory = new Map<string, string>();
  let fail = false,
    uploads = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      if (request.method === 'GET') return Response.json([...inventory].map(([key, hash]) => ({ key, hash })));
      if (fail) return new Response('Unavailable', { status: 503 });
      const { snapshot } = (await request.json()) as { snapshot: Snapshot };
      inventory.set(snapshotKey(snapshot), snapshotHash(snapshot));
      uploads++;
      return Response.json({});
    },
  });
  const config: RemoteConfig = {
    endpoint: server.url.toString(),
    token: 'fixture',
    allowHttp: false,
    identity: { userId: 'fixture', user: 'fixture', deviceId: 'fixture', device: 'Mac', scope: 'sync' },
  };
  try {
    mkdirSync(process.env.SESSIONS_ARCHIVE_DIR, { recursive: true });
    const path = join(process.env.SESSIONS_ARCHIVE_DIR, 'session.jsonl');
    writeFileSync(path, 'first content');
    writeFileSync(
      join(process.env.SESSIONS_ARCHIVE_DIR, 'manifest.json'),
      JSON.stringify({
        '/native.jsonl': {
          tool: 'claude',
          cwd: '/repo',
          sessionId: 'one',
          mtime: 1,
          size: 1,
          archivedAt: '2026-09-09T12:00:00.000Z',
          vaultPath: path,
        },
      }),
    );
    expect((await syncArchive(config)).uploaded).toBe(1);
    expect((await syncArchive(config)).unchanged).toBe(1);
    expect(uploads).toBe(1);
    writeFileSync(path, 'changed content');
    fail = true;
    await expect(syncArchive(config)).rejects.toThrow('503');
    expect(readFileSync(path, 'utf8')).toBe('changed content');
    fail = false;
    expect((await syncArchive(config)).uploaded).toBe(1);
    expect((await syncArchive(config)).uploaded).toBe(0);
    inventory.clear();
    expect((await syncArchive(config)).uploaded).toBe(1);
    const lock = new Database(join(process.env.SESSIONS_DATA_DIR, 'sync.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      expect((await syncArchive(config)).busy).toBe(true);
    } finally {
      lock.close();
    }
    expect(statSync(path).size).toBeGreaterThan(0);
  } finally {
    await server.stop(true);
    if (previousData === undefined) delete process.env.SESSIONS_DATA_DIR;
    else process.env.SESSIONS_DATA_DIR = previousData;
    if (previousArchive === undefined) delete process.env.SESSIONS_ARCHIVE_DIR;
    else process.env.SESSIONS_ARCHIVE_DIR = previousArchive;
    rmSync(root, { recursive: true, force: true });
  }
});
