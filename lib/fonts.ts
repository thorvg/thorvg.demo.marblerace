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
    void measureFace(name, data);
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

/** ThorVG lays text out from the hhea metrics; glyph ink is measured by the browser from the same bytes. */
interface Face {
  family: string;
  baseline: number;
}

const faces = new Map<string, Face>();
const drops = new Map<string, number>();
let ruler: CanvasRenderingContext2D | null = null;

async function measureFace(name: string, data: Uint8Array): Promise<void> {
  if (faces.has(name) || typeof FontFace === 'undefined') return;
  const lines = lineMetrics(data);
  if (!lines) return;

  try {
    const family = `tvg-measure-${name}`;
    const face = new FontFace(family, data.slice());
    await face.load();
    document.fonts.add(face);
    // Line box: ascent + descent + gap tall, baseline at the ascent; `align(x, 0.5)` anchors its middle.
    faces.set(name, { family, baseline: (lines.ascent - lines.descent - lines.gap) / 2 });
  } catch {
  }
}

function lineMetrics(data: Uint8Array): { ascent: number; descent: number; gap: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const find = (tag: string): number => {
    const count = view.getUint16(4);
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      const name = String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
      if (name === tag) return view.getUint32(at + 8);
    }
    return -1;
  };

  try {
    const head = find('head');
    const hhea = find('hhea');
    if (head < 0 || hhea < 0) return null;
    const em = view.getUint16(head + 18) || 1000;
    return {
      ascent: view.getInt16(hhea + 4) / em,
      descent: -view.getInt16(hhea + 6) / em,
      gap: view.getInt16(hhea + 8) / em,
    };
  } catch {
    return null;
  }
}

/** How far a glyph's ink sits below its `align(0.5, 0.5)` anchor, as a fraction of the font size. */
export function glyphDrop(font: string, glyph: string): number {
  const face = faces.get(font);
  if (!face) return 0;

  const key = `${font}\u0000${glyph}`;
  const cached = drops.get(key);
  if (cached !== undefined) return cached;

  ruler ??= document.createElement('canvas').getContext('2d');
  if (!ruler) return 0;
  ruler.font = `100px "${face.family}"`;
  const ink = ruler.measureText(glyph);
  const centre = (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 200;
  const drop = face.baseline - centre;
  drops.set(key, drop);
  return drop;
}
