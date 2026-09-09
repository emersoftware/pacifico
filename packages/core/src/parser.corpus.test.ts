/**
 * Optional read-only checks against native Claude and Codex transcripts on this machine.
 * Run separately from hermetic tests, allowing time to scan a multi-gigabyte corpus:
 *
 * SESSIONS_LIVE_CORPUS=1 bun test --timeout 120000 packages/core/src/parser.corpus.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Glob } from 'bun';
import { extractMessages } from './parser';

const ENABLED = process.env.SESSIONS_LIVE_CORPUS === '1';
const describeCorpus = ENABLED ? describe : describe.skip;

/** Real roots, not the SESSIONS_* test redirections - the point is the actual corpus. */
const CODEX_ROOT = join(homedir(), '.codex', 'sessions');
const CLAUDE_ROOT = join(homedir(), '.claude', 'projects');

// Kept in sync with the copy in parser.ts by the assertion below, which fails if a
// non-genuine turn appears that this pattern cannot explain.
const CODEX_INJECTED =
  /^(<environment_context|<user_action|<turn_aborted|<recommended_plugins|<image\b|<skill\b|<user_shell_command|# AGENTS\.md instructions for |Warning: )/;

async function* transcripts(root: string, pattern: string, cap: number): AsyncGenerator<string[]> {
  if (!existsSync(root)) return;
  let n = 0;
  for await (const p of new Glob(pattern).scan({ cwd: root, absolute: true })) {
    if (n++ >= cap) return;
    yield (await Bun.file(p).text()).split('\n').filter((l) => l.trim());
  }
}

describeCorpus('live corpus', () => {
  test('every substantive Codex rollout extracts messages', async () => {
    let files = 0;
    let substantive = 0;
    let extracted = 0;
    for await (const lines of transcripts(CODEX_ROOT, '**/rollout-*.jsonl', 5000)) {
      files++;
      // "Substantive" = carries at least one model-facing message record. A rollout that
      // was opened and abandoned holds only session_meta and legitimately yields nothing.
      const hasMessage = lines.some((l) => {
        try {
          const d = JSON.parse(l);
          return d?.type === 'response_item' && d?.payload?.type === 'message';
        } catch {
          return false;
        }
      });
      if (!hasMessage) continue;
      substantive++;
      if (extractMessages(lines).length > 0) extracted++;
    }
    if (files === 0) return; // no Codex corpus on this machine
    expect(substantive).toBeGreaterThan(0);
    expect(extracted).toBe(substantive);
  });

  test('Codex non-genuine turns are all explained by the injection prefixes', async () => {
    // The event_msg join and the prefix regex are independent signals. On the corpus they
    // agree exactly; a turn marked non-genuine that no prefix explains means the join has
    // started mis-firing (a whitespace-normalization drift between the two streams would
    // look like this), which is the failure mode that silently blanks first_prompt.
    const unexplained: string[] = [];
    for await (const lines of transcripts(CODEX_ROOT, '**/rollout-*.jsonl', 5000)) {
      for (const m of extractMessages(lines)) {
        if (m.role !== 'user' || m.genuine) continue;
        if (!CODEX_INJECTED.test(m.text.trim())) unexplained.push(m.text.slice(0, 80));
      }
    }
    expect(unexplained).toEqual([]);
  });

  test('numbering stays dense on every real transcript', async () => {
    // array[i].index === i is what get_session_messages pagination and message_fts hit
    // offsets both rely on. A harness-specific branch that emits out of order breaks
    // search-result deep-linking without breaking any single-message assertion.
    const roots: [string, string][] = [
      [CODEX_ROOT, '**/rollout-*.jsonl'],
      [CLAUDE_ROOT, '**/*.jsonl'],
    ];
    for (const [root, pattern] of roots) {
      for await (const lines of transcripts(root, pattern, 1500)) {
        const msgs = extractMessages(lines);
        expect(msgs.map((m) => m.index)).toEqual(msgs.map((_, i) => i));
      }
    }
  });

  test('no harness extracts to zero across its whole corpus', async () => {
    // The bug this file exists for, stated generally: a harness whose every transcript
    // yields nothing is a dispatch gap, never real data.
    for (const [label, root, pattern] of [
      ['codex', CODEX_ROOT, '**/rollout-*.jsonl'],
      ['claude', CLAUDE_ROOT, '**/*.jsonl'],
    ] as const) {
      let files = 0;
      let total = 0;
      for await (const lines of transcripts(root, pattern, 800)) {
        files++;
        total += extractMessages(lines).length;
      }
      if (files === 0) continue;
      expect({ label, zero: total === 0 }).toEqual({ label, zero: false });
    }
  });
});
