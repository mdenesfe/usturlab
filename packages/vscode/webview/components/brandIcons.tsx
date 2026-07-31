/**
 * Stylized, hand-drawn provider marks (not official assets) in each brand's
 * signature color, so accounts are recognizable at a glance.
 */

export const BRAND_COLOR: Record<string, string> = {
  claude: '#D97757',
  codex: '#10A37F',
  gemini: '#4E8CF9',
  copilot: '#8957E5',
};

export const PROVIDER_NAME: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex · ChatGPT',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
};

/** Claude — organic starburst. */
export function ClaudeMark({ size = 16 }: { size?: number }) {
  const rays = [];
  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 * Math.PI) / 180;
    const r = i % 2 === 0 ? 10.5 : 7.5;
    rays.push(
      <line
        key={i}
        x1={12 + Math.cos(angle) * 3.2}
        y1={12 + Math.sin(angle) * 3.2}
        x2={12 + Math.cos(angle) * r}
        y2={12 + Math.sin(angle) * r}
      />,
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      stroke={BRAND_COLOR.claude}
      stroke-width="2.4"
      stroke-linecap="round"
      fill="none"
    >
      {rays}
    </svg>
  );
}

/** Codex/OpenAI — hexagonal knot (simplified). */
export function CodexMark({ size = 16 }: { size?: number }) {
  const petals = [];
  for (let i = 0; i < 6; i++) {
    petals.push(
      <g key={i} transform={`rotate(${i * 60} 12 12)`}>
        <path d="M12 3.2 a4.3 4.3 0 0 1 4.3 4.3 v3.1 L12 13.1 l-4.3 -2.5 V7.5 A4.3 4.3 0 0 1 12 3.2 Z" />
      </g>,
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={BRAND_COLOR.codex}
      stroke-width="1.7"
      stroke-linejoin="round"
    >
      {petals}
    </svg>
  );
}

/** Gemini — four-point sparkle with the blue→purple gradient. */
export function GeminiMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <defs>
        <linearGradient id="gem-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#4E8CF9" />
          <stop offset="100%" stop-color="#9B72CB" />
        </linearGradient>
      </defs>
      <path
        d="M12 2 C12.6 7.6 16.4 11.4 22 12 C16.4 12.6 12.6 16.4 12 22 C11.4 16.4 7.6 12.6 2 12 C7.6 11.4 11.4 7.6 12 2 Z"
        fill="url(#gem-grad)"
      />
    </svg>
  );
}

/** Copilot — the goggles. */
export function CopilotMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M4 9.5 C4 6.8 7 5.5 12 5.5 C17 5.5 20 6.8 20 9.5 V14 C20 16.8 16.8 18.5 12 18.5 C7.2 18.5 4 16.8 4 14 Z"
        stroke={BRAND_COLOR.copilot}
        stroke-width="1.7"
      />
      <rect x="6.7" y="9.4" width="4.2" height="5" rx="1.6" fill={BRAND_COLOR.copilot} />
      <rect x="13.1" y="9.4" width="4.2" height="5" rx="1.6" fill={BRAND_COLOR.copilot} />
    </svg>
  );
}

export function BrandMark({ provider, size = 16 }: { provider: string; size?: number }) {
  switch (provider) {
    case 'claude':
      return <ClaudeMark size={size} />;
    case 'codex':
      return <CodexMark size={size} />;
    case 'gemini':
      return <GeminiMark size={size} />;
    case 'copilot':
      return <CopilotMark size={size} />;
    default:
      return null;
  }
}
