interface IconProps {
  size?: number;
}

const base = (size = 14) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.2',
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
});

export const IconPlus = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const IconHistory = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </svg>
);

export const IconOpenInTab = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
    <path d="M8.5 2.5v11M2.5 5.5h11" style="display:none" />
    <path d="M6 6l4 4M10 6v4h-4" style="display:none" />
    <path d="M8.5 7.5L12 4M12 4h-2.5M12 4v2.5" />
  </svg>
);

export const IconTrash = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3.5 5h9M6.5 5V3.5h3V5M5 5l.5 7.5h5L11 5" />
  </svg>
);

export const IconSend = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2.5 8h9M8.5 4.5L12 8l-3.5 3.5" />
  </svg>
);

export const IconStop = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconBack = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9.5 3.5L5 8l4.5 4.5" />
  </svg>
);

export const IconEdit = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M11.5 2.5l2 2L6 12l-2.7.7L4 10z" />
  </svg>
);

export const IconAccounts = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3.5 13c.7-2.6 2.3-3.5 4.5-3.5s3.8.9 4.5 3.5" />
  </svg>
);

/** The usturlab mark: astrolabe bowl (currentColor) + sighted star (Türk kırmızısı). */
export const IconUsturlab = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M2.8 13.2 A9.2 9.2 0 0 0 21.2 13.2 Z" fill="currentColor" />
    <circle cx="12" cy="6.8" r="2" fill="#E30A17" />
  </svg>
);

export const IconRoute = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2.5 4.5h4l3 7h4" />
    <path d="M2.5 11.5h4" style="opacity:.55" />
    <path d="M11 2.5l2.5 2-2.5 2" style="display:none" />
    <circle cx="13.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="2.5" cy="4.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconAnalytics = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3" y="9" width="2" height="5" rx="0.5" fill="currentColor" stroke="none" />
    <rect x="7" y="5" width="2" height="9" rx="0.5" fill="currentColor" stroke="none" />
    <rect x="11" y="7" width="2" height="7" rx="0.5" fill="currentColor" stroke="none" />
  </svg>
);
