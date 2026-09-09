import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Newly supported sources must never fall through to the developer's real history in unit tests.
const root = mkdtempSync(join(tmpdir(), 'pacifico-test-sources-'));
process.env.SESSIONS_NATIVE_HOME = root;
process.env.SESSIONS_CURSOR_DIR = join(root, 'cursor');
process.env.SESSIONS_ANTIGRAVITY_DIR = join(root, 'gemini');
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
