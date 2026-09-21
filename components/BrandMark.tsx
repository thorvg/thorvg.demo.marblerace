/**
 * App mark: the pinball marble carrying the ThorVG spectrum. Same artwork as
 * app/icon.svg, inlined so the header needs no extra request.
 */
export default function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="markSpectrum" x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#0075FF" />
          <stop offset="33%" stopColor="#00E5A3" />
          <stop offset="66%" stopColor="#FFDD00" />
          <stop offset="100%" stopColor="#FF3300" />
        </linearGradient>
        <radialGradient id="markShade" cx="35%" cy="30%" r="65%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.5" />
          <stop offset="40%" stopColor="#000000" stopOpacity="0" />
          <stop offset="80%" stopColor="#000000" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.75" />
        </radialGradient>
        <linearGradient id="markTop" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="markBottom" x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect width="512" height="512" rx="112" fill="#08080A" />
      <circle cx="256" cy="256" r="170" fill="url(#markSpectrum)" />
      <circle cx="256" cy="256" r="170" fill="url(#markShade)" />
      <ellipse cx="240" cy="145" rx="100" ry="42" fill="url(#markTop)" transform="rotate(-15, 240, 145)" />
      <ellipse cx="256" cy="395" rx="110" ry="20" fill="url(#markBottom)" opacity="0.6" />
    </svg>
  );
}
