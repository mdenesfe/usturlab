import { useEffect, useState } from 'preact/hooks';

/**
 * Copying is the most common thing anyone does with an answer, and dragging a
 * selection across a stream that is still moving is miserable. The button
 * confirms in place — a toast for something this small would be worse than
 * silence, and silence would leave you wondering whether it worked.
 */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older webviews reject the async API even with a real click behind it.
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  text,
  label = 'Copy',
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1400);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      class={`copy-btn ${state} ${className}`}
      title={label}
      aria-label={label}
      onClick={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        setState((await copyText(text)) ? 'done' : 'failed');
      }}
    >
      {state === 'done' ? '✓ copied' : state === 'failed' ? 'press ⌘C' : label}
    </button>
  );
}
