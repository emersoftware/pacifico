import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installedExecutable } from './executable';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-brew-'));
  roots.push(root);
  const keg = join(root, 'Cellar', 'pacifico', '0.1.0');
  const binary = join(keg, 'bin', 'pacifico');
  const opt = join(root, 'opt', 'pacifico');
  mkdirSync(join(keg, 'bin'), { recursive: true });
  mkdirSync(join(root, 'opt'));
  writeFileSync(binary, 'fixture');
  return { root, keg, binary, opt };
}

describe('installed executable', () => {
  test('uses the stable Homebrew alias across keg replacement', () => {
    const { root, keg, binary, opt } = fixture();
    symlinkSync(keg, opt);
    const configured = installedExecutable(binary);
    expect(configured).toBe(join(opt, 'bin', 'pacifico'));
    const nextKeg = join(root, 'Cellar', 'pacifico', '0.1.1');
    mkdirSync(join(nextKeg, 'bin'), { recursive: true });
    writeFileSync(join(nextKeg, 'bin', 'pacifico'), 'next version');
    rmSync(opt);
    symlinkSync(nextKeg, opt);
    rmSync(keg, { recursive: true });
    expect(installedExecutable(join(nextKeg, 'bin', 'pacifico'))).toBe(configured);
    expect(readFileSync(configured, 'utf8')).toBe('next version');
  });

  test('does not select a different installed version', () => {
    const { root, binary, opt } = fixture();
    const other = join(root, 'other');
    mkdirSync(join(other, 'bin'), { recursive: true });
    writeFileSync(join(other, 'bin', 'pacifico'), 'other');
    symlinkSync(other, opt);
    expect(installedExecutable(binary)).toBe(binary);
  });

  test('falls back when the stable alias does not exist', () => {
    const { binary } = fixture();
    expect(installedExecutable(binary)).toBe(binary);
  });

  test('preserves standalone and development paths', () => {
    for (const path of ['/custom/bin/pacifico', '/opt/homebrew/bin/bun', '/project/dist/pacifico']) {
      expect(installedExecutable(path)).toBe(path);
    }
  });
});
