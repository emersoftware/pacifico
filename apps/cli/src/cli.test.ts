// src/cli.test.ts
import { test, expect } from 'bun:test';
import { parseArgs, toSearchOptions } from './cli';
import { formatLine } from './display';
import type { SessionResult } from '@pacifico/core/types';

test('parseArgs: --errored sets the flag; query and tool still parse', () => {
  const a = parseArgs(['--errored', '--tool', 'claude', 'rate limit']);
  expect(a.errored).toBe(true);
  expect(a.toolFilter).toBe('claude');
  expect(a.searchQuery).toBe('rate limit');
});

test('toSearchOptions: maps CLI args + repoRoot to a SearchOptions call', () => {
  const a = parseArgs(['--errored', '--here', 'auth']);
  const { query, opts } = toSearchOptions(a, '/repo');
  expect(query).toBe('auth');
  expect(opts.errored).toBe(true);
  expect(opts.project).toBe('/repo');
  expect(opts.tool).toBe('');
  expect(opts.limit).toBeGreaterThan(0);
});

test('parseArgs: --file is repeatable and maps through toSearchOptions', () => {
  const a = parseArgs(['--file', 'src/auth.ts', '--file', 'docs/plan.md']);
  expect(a.files).toEqual(['src/auth.ts', 'docs/plan.md']);
  const { opts } = toSearchOptions(a, '');
  expect(opts.files).toEqual(['src/auth.ts', 'docs/plan.md']);
});

test('narrow display preserves the full prompt in its TSV field', () => {
  const prompt = 'a prompt long enough to be truncated at sixty columns for sure';
  const result: SessionResult = {
    date: '2026-08-04',
    createdAt: '2026-08-04',
    cwd: '/repo',
    tool: 'claude',
    sessionId: 'abc',
    displayText: prompt,
    customTitle: '',
    messageCount: 8,
    filePath: '/f.jsonl',
    exists: true,
    files: [],
    commands: [],
    errored: false,
  };
  const fields = formatLine(result, 60).split('\t');
  expect(fields).toHaveLength(7);
  expect(fields[5]).toBe(prompt);
  expect(fields[6]).toContain('…');
  expect(fields[6]).not.toContain('sixty columns for sure');
});
