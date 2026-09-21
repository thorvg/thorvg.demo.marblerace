/**
 * A pooled slot for a piece of artwork: an image, an SVG or a Lottie.
 *
 * ThorVG loads a still into a Picture and an animation into an Animation with
 * its own picture, so a slot carries both and lights up whichever the artwork
 * needs. Loading is keyed, so moving or resizing a decal costs a transform
 * rather than a decode.
 *
 * Shared by the flat board and the 3D preview, which each keep their own slots
 * because the two views hold the same artwork at different transforms and are
 * both on screen during the handover between them.
 */

import type { Animation, Picture, Scene, ThorVGNamespace } from '@thorvg/webcanvas';
import { skinKey, skinPayload, type Skin } from '../skins';

export interface ArtSlot {
  picture: Picture;
  animation: Animation;
  /** Which of the two paints is carrying the artwork. */
  mode: 'none' | 'picture' | 'animation';
  key: string;
  frames: number;
  fps: number;
  /** Last size pushed into the paint, so a still decal costs nothing. */
  width: number;
  height: number;
}

/**
 * Both paints join the scene up front, so a slot keeps its place in the draw
 * order whichever kind of artwork later lands in it.
 */
export function makeArtSlot(tvg: ThorVGNamespace, scene: Scene): ArtSlot {
  const picture = new tvg.Picture();
  scene.add(picture);

  const animation = new tvg.Animation();
  const animPicture = animation.picture;
  if (animPicture) scene.add(animPicture);

  return { picture, animation, mode: 'none', key: '', frames: 0, fps: 30, width: 0, height: 0 };
}

/** Loads artwork into a slot, doing nothing if it already holds that piece. */
export function loadArt(slot: ArtSlot, art: Skin): void {
  const key = skinKey(art);
  if (key === slot.key) return;

  slot.key = key;
  slot.mode = 'none';
  slot.frames = 0;
  slot.width = 0;
  slot.height = 0;

  const payload = skinPayload(art);
  if (!payload) return;

  if (art.type === 'lot') {
    slot.animation.load(payload as string);
    const info = slot.animation.info();
    slot.frames = info?.totalFrames ?? 0;
    slot.fps = info?.fps || 30;
    slot.mode = 'animation';
    return;
  }

  slot.picture.load(payload, { type: art.type });
  slot.mode = 'picture';
}

/** The paint carrying the artwork, or null when the slot is empty. */
export function artPaint(slot: ArtSlot): Picture | null {
  if (slot.mode === 'none') return null;
  return (slot.mode === 'animation' ? slot.animation.picture : slot.picture) ?? null;
}

/** Resizes the artwork, skipping the call when nothing moved. */
export function sizeArt(slot: ArtSlot, width: number, height: number): void {
  if (slot.width === width && slot.height === height) return;
  slot.width = width;
  slot.height = height;
  artPaint(slot)?.size(width, height);
}

/** Keeps the paint the slot is not using out of the frame. */
export function maskArt(slot: ArtSlot): void {
  (slot.mode === 'animation' ? slot.picture : slot.animation.picture)?.opacity(0);
}

/** A decal's 0..100 opacity as a paint alpha, dimmed by an optional fade. */
export function artAlpha(opacity: number, fade = 1): number {
  return Math.max(0, Math.min(255, Math.round((opacity / 100) * fade * 255)));
}

export function advanceArt(slot: ArtSlot, time: number): void {
  if (slot.mode === 'animation' && slot.frames > 1) {
    slot.animation.frame((time * slot.fps) % slot.frames);
  }
}

/**
 * Hiding is zero opacity rather than the visibility toggle, which asks the
 * backend for a region a paint that never rendered does not have.
 */
export function hideArt(slot: ArtSlot): void {
  slot.picture.opacity(0);
  slot.animation.picture?.opacity(0);
}
