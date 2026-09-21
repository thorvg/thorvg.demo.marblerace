/**
 * Locale handling.
 *
 * Resolution order on first load: `?lang=` in the URL, then the stored choice,
 * then the browser's preferred languages, then English.
 */

import { en } from './en';
import { ko } from './ko';
import { CJK_LOCALES, DEFAULT_LOCALE, LOCALES, type Locale, type Messages } from './types';

export { DEFAULT_LOCALE, LOCALES, type Locale, type Messages };

export const CATALOGUES: Record<Locale, Messages> = { en, ko };

export const LOCALE_STORAGE_KEY = 'thor-pinball.locale';

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

export function getMessages(locale: Locale): Messages {
  return CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
}

export function needsCjkFont(locale: Locale): boolean {
  return CJK_LOCALES.includes(locale);
}

/** Matches browser tags like `ko-KR` against the locales we ship. */
export function matchLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    const exact = LOCALES.find((locale) => lower === locale);
    if (exact) return exact;
    const base = LOCALES.find((locale) => lower.startsWith(`${locale}-`));
    if (base) return base;
  }
  return null;
}

/** Client only. Never called during the server render, so hydration stays stable. */
export function detectLocale(search?: string): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;

  const fromUrl = new URLSearchParams(search ?? window.location.search).get('lang');
  return isLocale(fromUrl) ? fromUrl : DEFAULT_LOCALE;
}

export function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore, the URL still carries the choice.
  }
}
