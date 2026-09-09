import { Store } from './store';
import { handler } from './http';
const database = process.env.DATABASE_URL;
if (!database) throw new Error('DATABASE_URL is required');
const store = new Store(database);
await store.migrate();
if (Bun.argv[2] === 'credential') {
  const user = Bun.argv[3],
    scope = Bun.argv[4],
    device = Bun.argv[5];
  if (!user || !['read', 'sync'].includes(scope ?? '') || (scope === 'sync' && !device))
    throw new Error('Usage: credential <user> read | credential <user> sync <device-name>');
  console.log(await store.credential(user, scope === 'sync' ? device : undefined));
  await store.close();
} else if (Bun.argv[2] === 'revoke') {
  const token = (await Bun.stdin.text()).trim();
  const { hash } = await import('@pacifico/core/sync/protocol');
  await store.sql`DELETE FROM credentials WHERE hash=${hash(token)}`;
  console.log('Credential revoked. Archived data retained.');
  await store.close();
} else {
  const server = Bun.serve({
    hostname: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8787),
    maxRequestBodySize: Number(process.env.MAX_UPLOAD_BYTES ?? 134217728),
    idleTimeout: 60,
    fetch: handler(store, process.env.PUBLIC_URL),
  });
  console.log(`Pacifico server listening on port ${server.port}`);
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, async () => {
      await server.stop();
      await store.close();
      process.exit(0);
    });
}
