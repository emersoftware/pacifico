import { useEffect, useRef, useState } from 'react';

type Props = {
  command: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
  failedLabel: string;
  theme?: 'dark' | 'light';
};

export default function CopyCommand({ command, label, copyLabel, copiedLabel, failedLabel, theme = 'light' }: Props) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const code = useRef<HTMLElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(command);
      setStatus('copied');
      timer.current = setTimeout(() => setStatus('idle'), 2500);
    } catch {
      // Keep the exact command selected for manual copying if permission is denied.
      if (code.current) {
        const range = document.createRange();
        range.selectNodeContents(code.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setStatus('failed');
    }
  }

  return (
    <div className={`command-block command-block--${theme}`}>
      <pre tabIndex={0} aria-label={label}>
        <code ref={code}>{command}</code>
      </pre>
      <button type="button" onClick={copy} aria-label={`${copyLabel}: ${label}`} className="copy-button">
        {status === 'copied' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m5 12 4 4L19 6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M15 5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h1"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        )}
        <span>{status === 'copied' ? copiedLabel : copyLabel}</span>
      </button>

      <span role="status" className={status === 'failed' ? 'copy-error' : 'sr-only'}>
        {status === 'failed' ? failedLabel : status === 'copied' ? copiedLabel : ''}
      </span>
    </div>
  );
}
