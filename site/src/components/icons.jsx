// Small line icons (inline SVG, so nothing loads from the internet). 16px, stroke = currentColor.
const Svg = ({ children, size = 16, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    {children}
  </svg>
);

export const IconSpark = (p) => (
  <Svg {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    <path d="M12 8.5l1.2 2.3 2.3 1.2-2.3 1.2L12 15.5l-1.2-2.3L8.5 12l2.3-1.2z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPlay = (p) => <Svg {...p}><path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" /></Svg>;
export const IconSend = (p) => <Svg {...p}><path d="M5 12h13M13 6l6 6-6 6" /></Svg>;
export const IconBook = (p) => <Svg {...p}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" /></Svg>;
export const IconUndo = (p) => <Svg {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Svg>;
export const IconRedo = (p) => <Svg {...p}><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></Svg>;
export const IconHistory = (p) => <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></Svg>;
export const IconClose = (p) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const IconChevron = (p) => <Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>;
export const IconCheck = (p) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const IconAlert = (p) => <Svg {...p}><path d="M12 8v5M12 16.5v.01" /><circle cx="12" cy="12" r="9" /></Svg>;
export const IconUser = (p) => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>;
export const IconDice = (p) => <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1" fill="currentColor" /><circle cx="15" cy="15" r="1" fill="currentColor" /></Svg>;
export const IconRepeat = (p) => <Svg {...p}><path d="M17 2l4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></Svg>;
export const IconMegaphone = (p) => <Svg {...p}><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15.5 8.5a5 5 0 0 1 0 7" /></Svg>;
export const IconCode = (p) => <Svg {...p}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /></Svg>;
export const IconText = (p) => <Svg {...p}><path d="M4 6h16M4 11h16M4 16h10" /></Svg>;

// The gun-barrel mark: concentric rings, used for the brand and empty states.
export const Barrel = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
    <circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
    <circle cx="20" cy="20" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="20" cy="20" r="2.5" fill="currentColor" />
  </svg>
);
