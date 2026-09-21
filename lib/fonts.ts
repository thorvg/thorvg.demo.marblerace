/**
 * Fonts are fetched once as raw bytes and handed to ThorVG directly.
 * The CJK face is 2.4 MB, so it is only pulled in when a name needs it.
 */

import type { ThorVGNamespace } from '@thorvg/webcanvas';

const CDN = 'https://cdn.jsdelivr.net/fontsource/fonts';

export const LATIN_FONT = 'jetbrains-mono';
export const CJK_FONT = 'noto-sans-kr';

const SOURCES: Record<string, string> = {
  [LATIN_FONT]: `${CDN}/${LATIN_FONT}@latest/latin-700-normal.ttf`,
  [CJK_FONT]: `${CDN}/${CJK_FONT}@latest/korean-700-normal.ttf`,
};

const bytes = new Map<string, Uint8Array>();
/** Faces registered with the live ThorVG instance. Cleared on term(). */
const registered = new Set<string>();
const pending = new Map<string, Promise<Uint8Array | null>>();

async function fetchFont(name: string): Promise<Uint8Array | null> {
  const cached = bytes.get(name);
  if (cached) return cached;

  let job = pending.get(name);
  if (!job) {
    job = (async () => {
      try {
        const res = await fetch(SOURCES[name]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        bytes.set(name, data);
        return data;
      } catch (err) {
        console.warn(`[thorvg-pinrace] font "${name}" could not be loaded:`, err);
        return null;
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, job);
  }
  return job;
}

/** Forgets which faces are registered - call after ThorVG.term(). */
export function resetFontRegistry(): void {
  registered.clear();
}

/** Loads a face into the current ThorVG instance. Safe to call repeatedly. */
export async function loadFont(tvg: ThorVGNamespace, name: string): Promise<boolean> {
  if (registered.has(name)) return true;

  const data = await fetchFont(name);
  if (!data) return false;
  try {
    tvg.Font.load(name, data, { type: 'ttf' });
    registered.add(name);
    return true;
  } catch (err) {
    console.warn(`[thorvg-pinrace] font "${name}" could not be registered:`, err);
    return false;
  }
}

/** True when the text is fully covered by the latin face. */
export function isLatin(text: string): boolean {
  return !/[^\u0000-ɏ -⁯₠-₿]/.test(text);
}

export function needsCjk(texts: readonly string[]): boolean {
  return texts.some((text) => !isLatin(text));
}

export type FontResolver = (text: string) => string;

export function fontResolver(cjkReady: boolean): FontResolver {
  return (text: string) => (!isLatin(text) && cjkReady ? CJK_FONT : LATIN_FONT);
}
