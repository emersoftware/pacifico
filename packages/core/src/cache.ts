// Compatibility exports for existing internal callers.
export * from './retrieval/sessions';
export { getCacheDir, getDbPath } from './storage/index';
export { clearCache, closeDb, refreshIndex, ensureIndexFresh } from './ingestion/sessions';
