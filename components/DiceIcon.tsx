/** A die, for the controls that roll something rather than set it. */
export default function DiceIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <rect
        x="2.2"
        y="2.2"
        width="11.6"
        height="11.6"
        rx="2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="5.6" cy="5.6" r="1.1" fill="currentColor" />
      <circle cx="10.4" cy="10.4" r="1.1" fill="currentColor" />
      <circle cx="10.4" cy="5.6" r="1.1" fill="currentColor" />
      <circle cx="5.6" cy="10.4" r="1.1" fill="currentColor" />
    </svg>
  );
}
