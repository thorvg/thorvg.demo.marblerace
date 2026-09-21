/**
 * Artwork laid on the flat board: images, SVGs and Lotties dropped into a map.
 *
 * Decals live in their own world space scene behind the track, so whatever is
 * dropped reads as a backdrop and never hides the course. Nothing here touches
 * the physics — the solver is handed a course with no knowledge of them.
 */

import type { Scene, ThorVGNamespace } from '@thorvg/webcanvas';
import type { Decal } from '../types';
import { advanceArt, artAlpha, artPaint, hideArt, loadArt, makeArtSlot, maskArt, sizeArt, type ArtSlot } from './artwork';

export class DecalLayer {
  #tvg: ThorVGNamespace;
  #scene: Scene;
  #slots: ArtSlot[] = [];

  constructor(tvg: ThorVGNamespace, scene: Scene) {
    this.#tvg = tvg;
    this.#scene = scene;
  }

  /**
   * Slots are created in order and never reordered, so the scene keeps the
   * blueprint's own stacking: the first decal in the list is furthest back.
   */
  #slot(index: number): ArtSlot {
    let slot = this.#slots[index];
    if (!slot) {
      slot = makeArtSlot(this.#tvg, this.#scene);
      this.#slots.push(slot);
    }
    return slot;
  }

  update(decals: readonly Decal[], time: number): void {
    for (let i = 0; i < decals.length; i++) {
      const decal = decals[i];
      const slot = this.#slot(i);
      loadArt(slot, decal.art);

      const artwork = artPaint(slot);
      if (!artwork) {
        hideArt(slot);
        continue;
      }

      sizeArt(slot, decal.w, decal.h);
      artwork.opacity(artAlpha(decal.opacity)).translate(decal.x, decal.y);
      maskArt(slot);
      advanceArt(slot, time);
    }

    for (let i = decals.length; i < this.#slots.length; i++) hideArt(this.#slots[i]);
  }

  /** Empties every slot, for when the board is not showing artwork at all. */
  clear(): void {
    for (const slot of this.#slots) hideArt(slot);
  }
}
