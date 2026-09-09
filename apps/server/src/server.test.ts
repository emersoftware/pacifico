import { runDaemonPass } from '@pacifico/agents/daemon';
import { closeDb, searchSessions } from '@pacifico/core/cache';
import { archiveDocuments } from '@pacifico/core/storage/documents';
import { hash } from '@pacifico/core/sync/protocol';
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store';
import { handler } from './http';
import { snapshotHash, snapshotKey, remoteId, type Snapshot } from '@pacifico/core/sync/protocol';
import { connectRemote, remoteConfig, remoteRequest, disconnectRemote } from '@pacifico/core/sync/client';
import { syncArchive } from '@pacifico/core/sync/upload';
import { callRemoteTool, routeTool, response } from '@pacifico/agents/remote';

const database = process.env.PACIFICO_TEST_DATABASE_URL;
test.skipIf(!database)(
  'Postgres sync, isolation, remote MCP, offline fallback and durable retries',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pacifico-server-'));
    const environment = {
      SESSIONS_HOME: root,
      SESSIONS_NATIVE_HOME: root,
      SESSIONS_DATA_DIR: join(root, 'client'),
      SESSIONS_ARCHIVE_DIR: join(root, 'archive'),
      SESSIONS_CACHE_DIR: join(root, 'cache'),
      SESSIONS_CLAUDE_DIR: join(root, 'claude'),
      SESSIONS_CODEX_DIR: join(root, 'codex'),
      SESSIONS_CODEX_ARCHIVED_DIR: join(root, 'codex-archived'),
      SESSIONS_CURSOR_DIR: join(root, 'cursor'),
      SESSIONS_CURSOR_IDE_DIR: join(root, 'cursor-ide'),
      SESSIONS_ANTIGRAVITY_DIR: join(root, 'gemini'),
      SESSIONS_OPENCODE_DB: join(root, 'opencode.db'),
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    closeDb();
    const store = new Store(database!);
    await store.migrate();
    const user = `fixture-${crypto.randomUUID()}`;
    const aToken = await store.credential(user, 'Mac'),
      bToken = await store.credential(user, 'Desktop'),
      readToken = await store.credential(user),
      strangerToken = await store.credential(`other-${user}`, 'Other');
    const a = (await store.authenticate(aToken))!,
      b = (await store.authenticate(bToken))!;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler(store) });
    const endpoint = `http://127.0.0.1:${server.port}`;
    const config = { endpoint, token: aToken, identity: a, allowHttp: false };
    const cli = async (args: string[], input = '') => {
      const command = process.env.PACIFICO_TEST_CLI_BINARY
        ? [process.env.PACIFICO_TEST_CLI_BINARY]
        : [process.execPath, join(import.meta.dir, '../../cli/src/index.ts')];
      const child = Bun.spawn([...command, 'remote', ...args], {
        env: process.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      child.stdin.write(input);
      child.stdin.end();
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const session = (content: string): Snapshot => ({
      kind: 'session',
      harness: 'claude',
      sourcePath: '/same/session.jsonl',
      sessionId: 'same-id',
      cwd: '/repo',
      modifiedAt: '2026-09-09T12:00:00.000Z',
      content: [
        JSON.stringify({
          type: 'user',
          sessionId: 'same-id',
          cwd: '/repo',
          timestamp: '2026-09-09T12:00:00Z',
          message: { role: 'user', content },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-09-09T12:01:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        }),
      ].join('\n'),
    });
    const item = session('oceanquartz from Mac');
    try {
      expect((await fetch(endpoint + '/v1/me')).status).toBe(401);
      expect(
        (
          await fetch(endpoint + '/v1/me', {
            headers: { Authorization: `Bearer ${aToken}`, Origin: 'https://untrusted.example' },
          })
        ).status,
      ).toBe(403);
      await remoteRequest(config, '/v1/snapshots', { snapshot: item, previousHash: null });
      await remoteRequest(config, '/v1/snapshots', { snapshot: item, previousHash: null });
      expect((await store.sql`SELECT count(*)::int AS count FROM versions WHERE user_id=${a.userId}`)[0].count).toBe(1);
      const updated = session('oceanquartz updated Mac');
      await remoteRequest(config, '/v1/snapshots', { snapshot: updated, previousHash: snapshotHash(item) });
      await expect(
        remoteRequest(config, '/v1/snapshots', { snapshot: session('old retry'), previousHash: snapshotHash(item) }),
      ).rejects.toThrow('409');
      await store.save(b, session('oceanquartz from Desktop'), null);
      const reader = { ...config, token: readToken, identity: (await store.authenticate(readToken))! };
      await expect(remoteRequest(reader, '/v1/snapshots', { snapshot: item, previousHash: null })).rejects.toThrow(
        '403',
      );
      const search = await callRemoteTool(reader, 'search_sessions', { query: 'oceanquartz' });
      expect(search.isError).not.toBe(true);
      const payload = JSON.parse(search.content[0]!.text);
      expect(payload.result.data.count).toBe(2);
      expect(
        new Set(payload.result.data.results.map((r: { origin: { device: string } }) => r.origin.device)).size,
      ).toBe(2);
      for (const mode of ['literal', 'regex']) {
        const result = await callRemoteTool(reader, 'search_sessions', { mode, query: 'oceanquartz' });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0]!.text).result.data.totalHits).toBe(2);
      }
      const id = remoteId(b.deviceId!, snapshotKey(item));
      for (const format of ['digest', 'messages', 'events']) {
        const result = await callRemoteTool(reader, 'read_session', { filePath: id, format });
        expect(result.isError).not.toBe(true);
        expect(result.content[0]!.text).toContain('Desktop');
      }
      const stranger = { ...config, token: strangerToken, identity: (await store.authenticate(strangerToken))! };
      expect(
        JSON.parse((await callRemoteTool(stranger, 'search_sessions', { query: 'oceanquartz' })).content[0]!.text)
          .result.data.count,
      ).toBe(0);
      expect((await callRemoteTool(stranger, 'read_session', { filePath: id })).isError).toBe(true);
      expect((await callRemoteTool(reader, 'read_session', { filePath: '/etc/passwd' })).isError).toBe(true);
      const document: Snapshot = {
        ...item,
        kind: 'memory',
        sourcePath: '/memory/MEMORY.md',
        sessionId: '',
        content: 'oceanquartz native memory',
      };
      await store.save(b, document, null);
      const docs = await callRemoteTool(reader, 'native_documents', { query: 'oceanquartz', mode: 'search' });
      expect(docs.isError).not.toBe(true);
      const docId = JSON.parse(docs.content[0]!.text).results[0].id;
      expect(
        (await callRemoteTool(reader, 'native_documents', { mode: 'read', id: docId })).content[0]!.text,
      ).toContain('native memory');
      for (const args of [
        { mode: 'project', cwd: '/repo' },
        { mode: 'activity', startDate: '2026-09-09', endDate: '2026-09-09' },
        { mode: 'activity', startDate: '2026-09-09', endDate: '2026-09-09', detail: 'full' },
      ]) {
        const result = await callRemoteTool(reader, 'get_context', args);
        expect(result.isError).not.toBe(true);
        if (args.detail === 'full') expect(result.content[0]!.text).toContain('oceanquartz');
        if (args.mode === 'project')
          expect(JSON.parse(result.content[0]!.text).result.data.recent[0].closing.assistant).toBe('Done');
      }
      const connected = await cli(['connect', endpoint, '--token-stdin'], readToken);
      expect(connected.code).toBe(0);
      expect(JSON.parse(connected.stdout).scope).toBe('read');
      const searched = await cli(['search', 'oceanquartz', '--mode', 'literal', '--limit', '1']);
      expect(searched.code).toBe(0);
      expect(JSON.parse(searched.stdout).result.data.returnedHits).toBe(1);
      expect(JSON.parse(searched.stdout).content).toBeUndefined();
      const messages = await cli(['read', id, '--format', 'messages', '--offset', '1', '--limit', '1']);
      expect(messages.code).toBe(0);
      expect(JSON.parse(messages.stdout).result.data.messages).toEqual([{ role: 'assistant', text: 'Done' }]);
      const events = await cli(['read', id, '--format', 'events', '--limit', '1']);
      expect(events.code).toBe(0);
      const next = JSON.parse(events.stdout).result.data.next;
      const continued = await cli([
        'read',
        id,
        '--format',
        'events',
        '--offset',
        String(next.offset),
        '--character-offset',
        String(next.characterOffset),
        '--version',
        next.version,
      ]);
      expect(continued.code).toBe(0);
      expect(JSON.parse(continued.stdout).result.data.events[0].text).toContain('Done');
      const context = await cli(['context', '/repo']);
      expect(context.code).toBe(0);
      expect(JSON.parse(context.stdout).result.data.recent.length).toBe(2);
      const activityCli = await cli([
        'context',
        '--mode',
        'activity',
        '--start-date',
        '2026-09-09',
        '--end-date',
        '2026-09-09',
      ]);
      expect(activityCli.code).toBe(0);
      expect(JSON.parse(activityCli.stdout).result.data.totalSessions).toBe(2);
      const documents = await cli(['documents', 'oceanquartz']);
      expect(documents.code).toBe(0);
      expect(JSON.parse(documents.stdout).results[0].id).toBe(docId);
      const documentCli = await cli(['documents', '--id', docId, '--offset', '0', '--limit', '12']);
      expect(documentCli.code).toBe(0);
      expect(JSON.parse(documentCli.stdout).document.content).toBe('oceanquartz ');
      for (const args of [
        ['read', '/etc/passwd'],
        ['read', id, '--limit', 'nope'],
        ['search', 'oceanquartz', '--unknown'],
      ]) {
        const failed = await cli(args);
        expect(failed.code).toBe(1);
        expect(failed.stdout).toBe('');
        expect(failed.stderr.length).toBeGreaterThan(0);
      }
      for (let i = 0; i < 205; i++) {
        await store.save(
          a,
          { ...session(`countfixture ${i}`), sourcePath: `/many/${i}.jsonl`, sessionId: `count-${i}` },
          null,
        );
      }
      const activity = JSON.parse(
        (
          await callRemoteTool(reader, 'get_context', {
            mode: 'activity',
            startDate: '2026-09-09',
            endDate: '2026-09-09',
          })
        ).content[0]!.text,
      ).result.data;
      expect(activity.totalSessions).toBe(207);
      expect(activity.totalMessages).toBe(414);
      expect(activity.truncated).toBe(true);
      const longText = 'padding '.repeat(2000) + 'crossboundary ' + 'middle '.repeat(5000) + 'tailboundary';
      await store.save(a, { ...session(longText), sourcePath: '/long.jsonl' }, null);
      for (const args of [
        { mode: 'literal', query: 'padding crossboundary' },
        { mode: 'regex', query: 'crossboundary[\\s\\S]*tailboundary' },
      ]) {
        const result = await callRemoteTool(reader, 'search_sessions', args);
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0]!.text).result.data.totalHits).toBe(1);
      }
      await connectRemote(endpoint, aToken);
      expect(statSync(join(root, 'client/remote.json')).mode & 0o777).toBe(0o600);
      const combined = await routeTool('search_sessions', { query: 'oceanquartz' }, async () =>
        response({ result: { mode: 'ranked', data: { results: [], count: 0 } } }),
      );
      expect(JSON.parse(combined.content[0]!.text).result.data.count).toBe(1);
      mkdirSync(join(root, 'archive'), { recursive: true });
      const vault = join(root, 'archive/local.jsonl');
      writeFileSync(vault, item.content);
      writeFileSync(
        join(root, 'archive/manifest.json'),
        JSON.stringify({
          '/local.jsonl': {
            tool: 'claude',
            cwd: '/repo',
            sessionId: 'local',
            mtime: 1,
            size: 1,
            archivedAt: item.modifiedAt,
            vaultPath: vault,
          },
        }),
      );
      expect((await syncArchive()).uploaded).toBe(1);
      expect((await syncArchive()).uploaded).toBe(0);
      await store.sql`DELETE FROM search_chunks WHERE user_id=${a.userId} AND device_id=${a.deviceId}`;
      await store.sql`DELETE FROM snapshots WHERE user_id=${a.userId} AND device_id=${a.deviceId}`;
      expect((await syncArchive()).uploaded).toBe(1);
      expect(remoteConfig()?.identity.device).toBe('Mac');
      archiveDocuments(join(root, 'archive/native-documents'), [
        {
          harness: 'claude',
          kind: 'memory',
          path: '/native/MEMORY.md',
          content: 'nativeamber memory',
          sha256: hash('nativeamber memory'),
          modifiedAt: item.modifiedAt,
        },
      ]);
      expect((await syncArchive()).uploaded).toBe(1);
      expect(
        (await callRemoteTool(reader, 'native_documents', { mode: 'search', query: 'nativeamber' })).content[0]!.text,
      ).toContain('/native/MEMORY.md');
      mkdirSync(join(root, 'claude/project'), { recursive: true });
      const nativePath = join(root, 'claude/project/daemon.jsonl');
      writeFileSync(nativePath, session('daemonamber from local').content);
      await runDaemonPass();
      expect(JSON.parse(readFileSync(join(root, 'client/daemon-state.json'), 'utf8')).sync.uploaded).toBeGreaterThan(0);
      await runDaemonPass();
      expect(JSON.parse(readFileSync(join(root, 'client/daemon-state.json'), 'utf8')).sync.uploaded).toBe(0);
      expect((await callRemoteTool(reader, 'search_sessions', { query: 'daemonamber' })).content[0]!.text).toContain(
        'same-id',
      );

      await server.stop(true);
      await expect(syncArchive()).rejects.toThrow();
      writeFileSync(nativePath, session('offlineamber from local').content);
      await expect(runDaemonPass()).rejects.toThrow();
      expect((await searchSessions('offlineamber')).length).toBe(1);
      expect(JSON.parse(readFileSync(join(root, 'client/daemon-state.json'), 'utf8')).ok).toBe(false);

      const offline = await routeTool('search_sessions', { query: 'oceanquartz' }, async () =>
        response({ result: { mode: 'ranked', data: { results: [], count: 0 } } }),
      );
      expect(offline.isError).not.toBe(true);
      expect(offline.content[0]!.text).toContain('local data only');
      disconnectRemote();
    } finally {
      await server.stop(true);
      const accounts = await store.sql`SELECT id FROM users WHERE name=${user} OR name=${`other-${user}`}`;
      for (const account of accounts) {
        for (const table of ['search_messages', 'search_chunks', 'versions', 'snapshots', 'credentials', 'devices'])
          await store.sql.unsafe(`DELETE FROM ${table} WHERE user_id=$1`, [account.id]);
        await store.sql`DELETE FROM users WHERE id=${account.id}`;
      }
      await store.close();
      closeDb();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
