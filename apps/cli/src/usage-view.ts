import { emitKeypressEvents } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { queryUsage, type UsagePeriod } from '@pacifico/core/usage';

type Summary = ReturnType<typeof queryUsage>;
const labels: Record<UsagePeriod, string> = {
  all: 'All time',
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '365d': 'Last year',
};
const periods: UsagePeriod[] = ['all', 'today', '7d', '30d', '365d'];
export function formatTokens(value: number): string {
  for (const [scale, suffix] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const)
    if (value >= scale) return `${(value / scale).toFixed(1)}${suffix}`;
  return String(value);
}

export function renderUsage(result: Summary, width = 80, models = false): string {
  const columns = Math.max(7, Math.min(53, width - 6));
  const end = new Date(result.periods.all!.to + 'T12:00:00Z');
  const endWeekday = end.getUTCDay();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - endWeekday - (columns - 1) * 7);
  const activity = new Map(result.activity.map((row) => [row.date, row.tokens]));
  const max = Math.max(1, ...result.activity.map((row) => row.tokens));
  const cells = Array.from({ length: 7 }, () => '');
  const months = Array<string>(columns).fill(' ');
  let lastMonth = -1;
  for (let col = 0; col < columns; col++) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + col * 7 + weekday);
      const key = date.toISOString().slice(0, 10);
      const tokens = activity.get(key) ?? 0;
      cells[weekday] =
        cells[weekday]! + (date > end ? ' ' : tokens ? '░▒▓█'[Math.min(3, Math.floor((tokens / max) * 4))]! : '·');
      if (weekday === 0 && date.getUTCMonth() !== lastMonth) {
        const label = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
        if (col + 3 <= columns) for (let i = 0; i < 3; i++) months[col + i] = label[i]!;
        lastMonth = date.getUTCMonth();
      }
    }
  }
  const selected = result.period as UsagePeriod;
  const lines = [
    '▔'.repeat(Math.max(20, Math.min(width, 80))),
    '',
    'pacifico · usage',
    '',
    models ? 'Overview   [Models]' : '[Overview]   Models',
    '',
    '     ' + months.join(''),
  ];
  const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  cells.forEach((row, i) => lines.push(`${dayLabels[i]!.padEnd(4)} ${row}`));
  lines.push(
    '',
    '     Less · ░ ▒ ▓ █ More',
    '',
    periods.map((p) => (p === selected ? `[${labels[p]}]` : labels[p])).join(' · '),
    '',
  );
  if (models) {
    for (const row of result.groups) lines.push(`${formatTokens(row.tokens).padStart(8)}  ${row.key}`);
    if (result.truncated) lines.push('More results available with --limit.');
  } else {
    const o = result.overview;
    lines.push(
      `Top model: ${o.topModel ?? 'No recorded usage'}`,
      `Total tokens: ${formatTokens(result.periods[selected]!.tokens)}   Sessions: ${o.sessions}`,
      `Active days: ${o.activeDays}   Most active day: ${o.mostActiveDay ?? 'None'}`,
      `Current streak: ${result.streak.currentDays} days   Longest streak: ${result.streak.longestDays} days (all time)`,
      '',
      `Input ${formatTokens(o.breakdown.input)} · Output ${formatTokens(o.breakdown.output)}`,
      `Cache read ${formatTokens(o.breakdown.cacheRead)} · Cache write ${formatTokens(o.breakdown.cacheWrite)}`,
      '',
      ...periods.map((p) => `${labels[p].padEnd(13)} ${formatTokens(result.periods[p]!.tokens)}`),
    );
  }
  lines.push(
    '',
    `Timezone: ${result.timezone} · B = 1 billion tokens`,
    'Recorded usage only; missing data is unknown.',
  );
  return (
    lines.map((line) => (line.length > width ? line.slice(0, Math.max(1, width - 1)) + '…' : line)).join('\n') + '\n'
  );
}

export async function showUsage(options: Parameters<typeof queryUsage>[0], interactive: boolean): Promise<void> {
  let period = options?.period ?? 'all';
  let models = options?.group === 'model';
  const snapshotTime = new Date();
  const cache = new Map<string, Summary>();
  const snapshot = () => {
    const key = `${period}:${models}`;
    if (!cache.has(key))
      cache.set(key, queryUsage({ ...options, now: snapshotTime, period, group: models ? 'model' : options?.group }));
    return cache.get(key)!;
  };
  const view = () => renderUsage(snapshot(), process.stdout.columns || 80, models);
  if (!interactive) {
    process.stdout.write(view());
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const raw = process.stdin.isRaw;
    const paused = process.stdin.isPaused();
    let notice = '';
    const draw = () =>
      process.stdout.write(
        '\x1b[H\x1b[2J' + view() + '\nr cycle dates · tab overview/models · ctrl+s copy · q quit\n' + notice,
      );
    const finish = (error?: unknown) => {
      process.stdin.removeListener('keypress', onKey);
      process.stdout.removeListener('resize', draw);
      process.stdin.setRawMode(raw);
      if (paused) process.stdin.pause();
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      if (error) reject(error);
      else resolve();
    };
    const onKey = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      try {
        if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish();
        if (key.name === 'r') period = periods[(periods.indexOf(period) + 1) % periods.length]!;
        if (key.name === 'tab') models = !models;
        if (key.ctrl && key.name === 's') {
          const command =
            process.platform === 'darwin'
              ? ['pbcopy']
              : process.platform === 'win32'
                ? ['clip']
                : process.env.WAYLAND_DISPLAY
                  ? ['wl-copy']
                  : ['xclip', '-selection', 'clipboard'];
          const copied = spawnSync(command[0]!, command.slice(1), { input: view(), timeout: 2000 });
          notice = copied.status === 0 ? 'Copied.\n' : 'Clipboard unavailable. Use pacifico usage > usage.txt\n';
        }
        draw();
      } catch (error) {
        finish(error);
      }
    };
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    process.stdout.on('resize', draw);
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    try {
      draw();
    } catch (error) {
      finish(error);
    }
  });
}
