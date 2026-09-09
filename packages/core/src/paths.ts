import { join } from 'node:path';
import { homedir } from 'node:os';

/** Resolve the configured home lazily for isolated installs and native-source discovery. */
export function getHome(): string {
  return process.env.SESSIONS_HOME || homedir();
}

/** Durable user data survives integration uninstall. */
export function getDataDir(): string {
  return process.env.SESSIONS_DATA_DIR || join(getHome(), '.local', 'share', 'pacifico');
}

/** Latest durable session snapshots, with an optional directory override. */
export function getArchiveDir(): string {
  return process.env.SESSIONS_ARCHIVE_DIR || join(getDataDir(), 'archive');
}
