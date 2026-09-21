'use client';

interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export default function Toggle({ checked, disabled, label, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full border transition disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        borderColor: checked ? 'var(--accent)' : 'var(--line)',
        background: checked ? 'var(--accent)' : 'var(--sunken)',
      }}
    >
      <span
        className="absolute top-1/2 block h-[14px] w-[14px] -translate-y-1/2 rounded-full transition-all"
        style={{
          left: checked ? 20 : 3,
          background: checked ? '#180a02' : '#6c6c74',
        }}
      />
    </button>
  );
}
