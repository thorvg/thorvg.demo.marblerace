/**
 * Artwork: an image, an SVG or a Lottie, carried by a marble or laid on a map.
 *
 * Artwork is kept as a data URI so a session or a map file carries it with no
 * external references, and ThorVG gets the decoded bytes when it is drawn.
 *
 * Two packed formats are unwrapped on the way in and stored as the plain
 * animation they already hold: a Telegram sticker (`.tgs`), which is gzipped
 * Lottie, and a dotLottie (`.lottie`), which is a zip of animations plus their
 * image assets. Both come out the other side as an ordinary embedded Lottie,
 * so nothing downstream needs to know they were ever packed.
 */

import { ZipArchive } from './zip';

export type SkinKind = 'image' | 'svg' | 'lottie';

/** Picture types ThorVG can load for a skin. */
export type SkinType = 'png' | 'jpg' | 'webp' | 'svg' | 'lot';

export interface Skin {
  kind: SkinKind;
  type: SkinType;
  /** Original file name, shown in the roster. */
  label: string;
  /** data: URI holding the artwork. */
  uri: string;
  /**
   * PNG data URI of the first frame, for a Lottie. The roster chip is DOM and
   * cannot run the animation, so it shows this still instead.
   */
  thumb?: string;
}

export const SKIN_ACCEPT =
  '.svg,.png,.jpg,.jpeg,.webp,.json,.tgs,.lottie,image/svg+xml,image/png,image/jpeg,image/webp,application/json';

/** Anything larger would bloat a stored session past what is reasonable. */
export const SKIN_MAX_BYTES = 4 * 1024 * 1024;

const SKIN_TYPES: SkinType[] = ['png', 'jpg', 'webp', 'svg', 'lot'];

/** Reads a stored skin back, dropping anything that is not plainly one. */
export function readSkin(value: unknown): Skin | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Skin>;
  if (typeof raw.uri !== 'string' || !raw.uri.startsWith('data:')) return null;
  if (!raw.type || !SKIN_TYPES.includes(raw.type)) return null;
  const kind = raw.type === 'lot' ? 'lottie' : raw.type === 'svg' ? 'svg' : 'image';
  const thumb = typeof raw.thumb === 'string' && raw.thumb.startsWith('data:') ? raw.thumb : undefined;
  return { kind, type: raw.type, label: typeof raw.label === 'string' ? raw.label : 'skin', uri: raw.uri, thumb };
}

/** True for a Telegram sticker, which is a Lottie inside a gzip wrapper. */
function isSticker(file: File): boolean {
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return name.endsWith('.tgs') || mime === 'application/x-tgs' || mime === 'application/gzip';
}

/** True for a dotLottie, which is a zip holding one or more animations. */
function isDotLottie(file: File): boolean {
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return name.endsWith('.lottie') || mime === 'application/zip' || mime === 'application/x-zip-compressed';
}

function typeFor(file: File): { kind: SkinKind; type: SkinType } | null {
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();

  if (isSticker(file) || isDotLottie(file)) return { kind: 'lottie', type: 'lot' };
  if (mime === 'image/svg+xml' || name.endsWith('.svg')) return { kind: 'svg', type: 'svg' };
  if (mime === 'image/png' || name.endsWith('.png')) return { kind: 'image', type: 'png' };
  if (mime === 'image/jpeg' || name.endsWith('.jpg') || name.endsWith('.jpeg')) return { kind: 'image', type: 'jpg' };
  if (mime === 'image/webp' || name.endsWith('.webp')) return { kind: 'image', type: 'webp' };
  if (mime === 'application/json' || name.endsWith('.json')) return { kind: 'lottie', type: 'lot' };
  return null;
}

export type SkinError = 'type' | 'size' | 'read' | 'unpack';

const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Unwraps gzip using the platform's own decompressor, so no inflate
 * implementation has to ship with the app. A sticker that turns out not to be
 * compressed is passed through, which is what a hand unpacked one looks like.
 */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) return bytes;
  if (typeof DecompressionStream !== 'function') throw new Error('no gzip support');

  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Base64 of raw bytes, chunked so a large animation does not blow the stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A rough check that unpacked bytes really are a Lottie, not some other gzip. */
function looksLikeLottie(text: string): boolean {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return Array.isArray(json.layers) && typeof json.w === 'number' && typeof json.h === 'number';
  } catch {
    return false;
  }
}

/** Reads a Telegram sticker into the plain Lottie it wraps. */
async function readSticker(file: File): Promise<{ skin: Skin } | { error: SkinError }> {
  let text: string;
  try {
    const packed = new Uint8Array(await file.arrayBuffer());
    const bytes = await gunzip(packed);
    // The size cap is about what a session can reasonably carry, so it is the
    // unpacked animation that has to fit, not the wrapper it arrived in.
    if (bytes.length > SKIN_MAX_BYTES) return { error: 'size' };
    text = new TextDecoder().decode(bytes);
  } catch {
    return { error: 'unpack' };
  }

  if (!looksLikeLottie(text)) return { error: 'unpack' };

  return {
    skin: {
      kind: 'lottie',
      type: 'lot',
      label: file.name,
      uri: `data:application/json;base64,${bytesToBase64(new TextEncoder().encode(text))}`,
    },
  };
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

interface LottieAsset {
  /** Directory the asset sits in, relative to the animation. */
  u?: string;
  /** File name, or the data URI itself once embedded. */
  p?: string;
  /** 1 marks `p` as embedded data rather than a path. */
  e?: number;
}

interface Manifest {
  animations?: Array<{ id?: unknown }>;
  activeAnimationId?: unknown;
}

/**
 * The animation a dotLottie leads with: the one its manifest marks active, or
 * else the first it lists. A dotLottie can hold several, and picking one is the
 * whole job here — the board shows a single piece of artwork.
 */
function primaryAnimation(manifest: Manifest | null, archive: ZipArchive): string | null {
  const ids = (manifest?.animations ?? [])
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === 'string');

  const active = typeof manifest?.activeAnimationId === 'string' ? manifest.activeAnimationId : null;
  const wanted = active && ids.includes(active) ? active : ids[0];
  if (wanted && archive.has(`animations/${wanted}.json`)) return `animations/${wanted}.json`;

  // No usable manifest: fall back to whatever animation the archive carries.
  return archive.names.find((name) => name.startsWith('animations/') && name.endsWith('.json')) ?? null;
}

/**
 * Rewrites an animation's image assets to carry their own bytes.
 *
 * A dotLottie keeps images beside the animation in the archive, which is a
 * reference the board could never resolve once the animation is embedded on
 * its own. Each one is pulled out of the zip and inlined instead.
 */
async function inlineAssets(animation: Record<string, unknown>, archive: ZipArchive): Promise<void> {
  const assets = animation.assets;
  if (!Array.isArray(assets)) return;

  for (const entry of assets as LottieAsset[]) {
    if (!entry || typeof entry.p !== 'string' || entry.e === 1) continue;
    if (entry.p.startsWith('data:')) continue;

    const file = entry.p;
    const candidates = [`${entry.u ?? ''}${file}`, `images/${file}`, file];
    let bytes: Uint8Array | null = null;
    for (const candidate of candidates) {
      bytes = await archive.read(candidate);
      if (bytes) break;
    }
    if (!bytes) continue;

    const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
    entry.p = `data:${IMAGE_MIME[extension] ?? 'image/png'};base64,${bytesToBase64(bytes)}`;
    entry.u = '';
    entry.e = 1;
  }
}

/** Reads a dotLottie into the single animation the board will draw. */
async function readDotLottie(file: File): Promise<{ skin: Skin } | { error: SkinError }> {
  let text: string;
  try {
    const archive = ZipArchive.open(new Uint8Array(await file.arrayBuffer()));

    const manifestText = await archive.text('manifest.json');
    let manifest: Manifest | null = null;
    try {
      manifest = manifestText ? (JSON.parse(manifestText) as Manifest) : null;
    } catch {
      // A malformed manifest is not fatal; the archive is searched instead.
    }

    const path = primaryAnimation(manifest, archive);
    if (!path) return { error: 'unpack' };

    const raw = await archive.text(path);
    if (!raw || !looksLikeLottie(raw)) return { error: 'unpack' };

    const animation = JSON.parse(raw) as Record<string, unknown>;
    await inlineAssets(animation, archive);
    text = JSON.stringify(animation);
  } catch {
    return { error: 'unpack' };
  }

  const bytes = new TextEncoder().encode(text);
  // Inlining the images can push a small archive well past the cap, so the
  // animation is measured once it is standing on its own.
  if (bytes.length > SKIN_MAX_BYTES) return { error: 'size' };

  return {
    skin: {
      kind: 'lottie',
      type: 'lot',
      label: file.name,
      uri: `data:application/json;base64,${bytesToBase64(bytes)}`,
    },
  };
}

export async function readSkinFile(file: File): Promise<{ skin: Skin } | { error: SkinError }> {
  const kind = typeFor(file);
  if (!kind) return { error: 'type' };
  if (file.size > SKIN_MAX_BYTES) return { error: 'size' };

  if (isDotLottie(file)) return readDotLottie(file);
  if (isSticker(file)) return readSticker(file);

  try {
    const uri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return { skin: { kind: kind.kind, type: kind.type, label: file.name, uri } };
  } catch {
    return { error: 'read' };
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes a skin into what ThorVG's Picture.load expects. */
export function skinPayload(skin: Skin): Uint8Array | string | null {
  const comma = skin.uri.indexOf(',');
  if (comma < 0) return null;

  const header = skin.uri.slice(0, comma);
  const body = skin.uri.slice(comma + 1);

  const bytes = header.includes(';base64') ? base64ToBytes(body) : new TextEncoder().encode(decodeURIComponent(body));
  // Text formats go in as text so ThorVG parses them directly.
  if (skin.type === 'svg' || skin.type === 'lot') return new TextDecoder().decode(bytes);
  return bytes;
}

/**
 * Natural size of a piece of artwork, so a dropped file lands at its own
 * proportions. Anything that will not report a size falls back to a square,
 * which is better than refusing the drop.
 */
export async function artworkSize(skin: Skin): Promise<{ width: number; height: number }> {
  const square = { width: 300, height: 300 };

  if (skin.type === 'lot') {
    try {
      const payload = skinPayload(skin);
      const json = JSON.parse(typeof payload === 'string' ? payload : '') as { w?: number; h?: number };
      if (typeof json.w === 'number' && typeof json.h === 'number' && json.w > 0 && json.h > 0) {
        return { width: json.w, height: json.h };
      }
    } catch {
      // Not a Lottie the browser can parse; ThorVG will decide what to do with it.
    }
    return square;
  }

  return new Promise((resolve) => {
    const image = new Image();
    // An SVG with no intrinsic size decodes to 0, which the fallback catches.
    image.onload = () =>
      resolve(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : square,
      );
    image.onerror = () => resolve(square);
    image.src = skin.uri;
  });
}

/** Stable identity for a skin, used to tell when a marble needs rebuilding. */
export function skinKey(skin: Skin | undefined): string {
  if (!skin) return '';
  return `${skin.type}:${skin.uri.length}:${skin.uri.slice(-24)}`;
}
