import { dirname } from 'node:path';
import { type Database } from 'bun:sqlite';
import { type Harness } from '../sources/records';
import { readNativeDocuments } from '../sources/native-memory';
import { archiveDocuments, readArchivedDocuments } from '../storage/documents';
import { indexDocuments } from '../storage/document-index';

/** Imports native documents and rebuilds search from durable copies, including deleted sources. */
export function importDocuments(db: Database, home: string, archiveDirectory: string): number {
  const hasSessions = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  const projects = hasSessions
    ? db
        .query<{ harness: Harness; cwd: string }, []>(
          "SELECT DISTINCT tool AS harness, cwd FROM sessions WHERE tool IN ('claude','codex','cursor','antigravity','opencode') AND cwd <> ''",
        )
        .all()
    : [];
  archiveDocuments(
    archiveDirectory,
    readNativeDocuments(home, projects, {
      claudeProjects: process.env.SESSIONS_NATIVE_HOME ? undefined : process.env.SESSIONS_CLAUDE_DIR,
      codexHome:
        !process.env.SESSIONS_NATIVE_HOME && process.env.SESSIONS_CODEX_DIR
          ? dirname(process.env.SESSIONS_CODEX_DIR)
          : undefined,
    }),
  );
  const documents = readArchivedDocuments(archiveDirectory);
  indexDocuments(db, documents);
  return documents.length;
}
