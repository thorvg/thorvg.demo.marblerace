'use client';

import { CATALOGUES, LOCALES, type Locale } from '../lib/i18n';

interface LocaleSwitchProps {
  locale: Locale;
  label: string;
  onChange: (locale: Locale) => void;
}

export default function LocaleSwitch({ locale, label, onChange }: LocaleSwitchProps) {
  return (
    <div className="segment" role="group" aria-label={label}>
      {LOCALES.map((item) => (
        <button
          key={item}
          type="button"
          lang={item}
          data-active={locale === item}
          aria-pressed={locale === item}
          onClick={() => onChange(item)}
        >
          <span className="sm:hidden">{CATALOGUES[item].code}</span>
          <span className="hidden sm:inline">{CATALOGUES[item].name}</span>
        </button>
      ))}
    </div>
  );
}
