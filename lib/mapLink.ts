/**
 * A hand drawn map, carried by its own link.
 *
 * The map is compacted, gzipped and base64url'd into the address bar's hash,
 * so a link describes the whole track with no server and nothing to upload.
 * The hash is used rather than the query because the map is of no interest to
 * the server: it never leaves the browser, and it keeps every request small.
 *
 * Two things do not fit and are handled rather than hidden. Dropped artwork is
 * megabytes of data URI, so it is stripped and the roster panel says so; and a
 * map that still comes out too long for a link is refused outright instead of
 * producing a URL that some chat client will quietly truncate.
 */

import { cloneItems, parseBlueprint, type Blueprint } from './blueprint';

/**
 * Longest map code a link will carry. Browsers cope with far more, but chat
 * clients and mail readers are where a shared link actually travels, and they
 * are much less generous.
 */
export const MAP_CODE_MAX = 8000;

/** Query key inside the hash, so other fragment state could join it later. */
const KEY = 'map';

/** Enough places that no drag is ever visible, few enough to lose float tails. */
const PLACES = 3;

function round(value: number): number {
  const factor = 10 ** PLACES;
  return Math.round(value * factor) / factor;
}

/**
 * The map as a link should carry it: no artwork, no float noise, no ids.
 *
 * Ids only exist so the editor can point at a piece; a link describes a track,
 * and the parser mints fresh ones on the way back in. They are also random, so
 * they are the one part of a map that will not compress — dropping them is the
 * single biggest saving available.
 */
export function slimBlueprint(blueprint: Blueprint): Blueprint {
  const items = cloneItems(blueprint.items.filter((item) => item.kind !== 'decal'));

  for (const item of items) {
    const record = item as unknown as Record<string, unknown>;
    delete record.id;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'number' && Number.isFinite(value)) record[key] = round(value);
    }
  }

  return {
    version: blueprint.version,
    name: blueprint.name,
    seed: blueprint.seed,
    finishY: Math.round(blueprint.finishY),
    items,
    marks: blueprint.marks.map((mark) => ({ y: Math.round(mark.y), name: mark.name })),
  };
}

export function hasArtwork(blueprint: Blueprint): boolean {
  return blueprint.items.some((item) => item.kind === 'decal');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): Uint8Array {
  const padded = code.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type EncodeResult =
  | { code: string }
  /** The map is sound but too long to travel as a link. */
  | { error: 'too-large'; length: number }
  /** The browser has no gzip, so there is nothing to compress with. */
  | { error: 'unsupported' };

export async function encodeMap(blueprint: Blueprint): Promise<EncodeResult> {
  if (typeof CompressionStream !== 'function') return { error: 'unsupported' };

  const json = JSON.stringify(slimBlueprint(blueprint));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  const code = toBase64Url(packed);

  return code.length > MAP_CODE_MAX ? { error: 'too-large', length: code.length } : { code };
}

/** Decodes a map code. Anything unreadable comes back null rather than throwing. */
export async function decodeMap(code: string): Promise<Blueprint | null> {
  if (typeof DecompressionStream !== 'function') return null;

  try {
    const bytes = fromBase64Url(code);
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    const json = await new Response(stream).text();
    // Straight through the same tolerant parser a map file goes through, so a
    // hand edited link can never hand the solver geometry it cannot cope with.
    return parseBlueprint(json);
  } catch {
    return null;
  }
}

/** Reads the map code out of a location hash, if it carries one. */
export function readMapCode(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, '')).get(KEY);
  return code && code.length <= MAP_CODE_MAX ? code : null;
}

export function mapHash(code: string | null): string {
  return code ? `#${KEY}=${code}` : '';
}
