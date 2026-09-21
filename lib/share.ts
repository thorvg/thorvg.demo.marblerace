/**
 * The run a link describes.
 *
 * The address bar is the only thing a shared link carries, so both the page
 * and the preview card it generates read it through here: one parser, no way
 * for the card to describe a different race than the one that loads.
 */

import { MAX_NAMES, TRACK_LENGTHS, type TrackLength } from './course';
import { DEFAULT_LOCALE, LOCALES, type Locale } from './i18n';
import type { RaceMode } from './types';

export type Renderer = 'sw' | 'gl' | 'wg';

const RENDERERS: Renderer[] = ['sw', 'gl', 'wg'];
const TRACKS = Object.keys(TRACK_LENGTHS) as TrackLength[];

export interface SharedRun {
  names: string[];
  seed: string;
  track: TrackLength;
  renderer: Renderer;
  locale: Locale;
  mode: RaceMode;
}

/** Splits a pasted roster on the separators the roster field accepts. */
export function splitNames(raw: string): string[] {
  return raw
    .split(/[,;\n\t]/)
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/** Query values arrive as a string, a repeated string, or not at all. */
type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function readSharedRun(params: Params): SharedRun {
  const names = one(params.names);
  const seed = one(params.seed);
  const track = one(params.track) as TrackLength | null;
  const renderer = one(params.renderer) as Renderer | null;
  const locale = one(params.lang) as Locale | null;
  const mode = one(params.mode);

  return {
    names: names ? splitNames(names).slice(0, MAX_NAMES) : [],
    seed: (seed ?? 'THORVG').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'THORVG',
    track: track && TRACKS.includes(track) ? track : 'standard',
    renderer: renderer && RENDERERS.includes(renderer) ? renderer : 'gl',
    locale: locale && (LOCALES as readonly string[]).includes(locale) ? locale : DEFAULT_LOCALE,
    mode: mode === 'ranking' ? 'ranking' : 'winner',
  };
}

/** True when the text is covered by a latin face, so the card can skip the CJK one. */
export function isLatinText(text: string): boolean {
  return !/[^\u0000-\u024F\u2000-\u206F\u20A0-\u20BF]/.test(text);
}
