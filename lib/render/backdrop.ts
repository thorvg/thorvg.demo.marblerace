/**
 * Background: an animated gradient sky in screen space plus a slow parallax
 * field that drifts past at a quarter of the track speed, so the descent reads
 * as depth rather than a flat scroll.
 */

import type { RadialGradient, Scene, Shape, ThorVGNamespace } from '@thorvg/webcanvas';
import { AURORA, mix } from '../palette';
import type { RGB } from '../types';
import type { Viewport } from './common';

const DEEP: RGB = [22, 22, 27];
const NIGHT: RGB = [7, 7, 9];

export class Backdrop {
  #tvg: ThorVGNamespace;
  #sky: Shape;
  #skyFill: RadialGradient;
  #vignette: Shape;
  #orbs: Array<{ shape: Shape; fill: RadialGradient; x: number; y: number; hue: number; phase: number }> = [];
  #viewport: Viewport = { width: 1, height: 1 };
  #parallaxScene: Scene;
  /** Everything that depends on the course length, swapped out in one go. */
  #depth: Scene | null = null;

  constructor(tvg: ThorVGNamespace, skyScene: Scene, parallaxScene: Scene, courseHeight: number) {
    this.#tvg = tvg;
    this.#parallaxScene = parallaxScene;

    this.#sky = new tvg.Shape();
    this.#skyFill = new tvg.RadialGradient(0, 0, 1);
    skyScene.add(this.#sky);

    this.#vignette = new tvg.Shape();
    skyScene.add(this.#vignette);

    this.setCourse(courseHeight);
  }

  /** Reseeds the parallax field for a course of a different length. */
  setCourse(courseHeight: number): void {
    const tvg = this.#tvg;
    if (this.#depth) this.#parallaxScene.remove(this.#depth);
    this.#orbs.length = 0;

    const depth = new tvg.Scene();
    this.#parallaxScene.add(depth);
    this.#depth = depth;

    // Glow orbs seeded down the length of the course.
    const count = Math.max(4, Math.round(courseHeight / 900));
    for (let i = 0; i < count; i++) {
      const shape = new tvg.Shape();
      const radius = 320 + (i % 3) * 120;
      const fill = new tvg.RadialGradient(0, 0, radius);
      shape.appendCircle(0, 0, radius).fill(fill);
      depth.add(shape);
      this.#orbs.push({
        shape,
        fill,
        x: i % 2 === 0 ? 190 : 570,
        y: 200 + (i * courseHeight) / count,
        hue: i % AURORA.length,
        phase: i * 1.7,
      });
    }

    // Depth dashes: short marks that slide by slower than the track.
    const dashes = new tvg.Shape();
    for (let y = 0; y < courseHeight + 1200; y += 260) {
      dashes.appendRect(120, y, 3, 90, { rx: 1.5, ry: 1.5 });
      dashes.appendRect(640, y + 130, 3, 90, { rx: 1.5, ry: 1.5 });
    }
    dashes.fill(120, 150, 230, 26);
    depth.add(dashes);
  }

  layout(viewport: Viewport): void {
    this.#viewport = viewport;
    const { width, height } = viewport;
    const radius = Math.max(width, height) * 1.15;

    this.#skyFill = new this.#tvg.RadialGradient(width * 0.34, height * 0.22, radius);
    this.#sky.reset();
    this.#sky.appendRect(0, 0, width, height);

    const shade = new this.#tvg.RadialGradient(width / 2, height / 2, Math.max(width, height) * 0.78);
    shade.setStops([0, [0, 0, 0, 0]], [0.62, [0, 0, 0, 0]], [1, [0, 0, 0, 205]]);
    this.#vignette.reset();
    this.#vignette.appendRect(0, 0, width, height).fill(shade);
  }

  update(time: number): void {
    const { width, height } = this.#viewport;
    if (width < 2) return;

    // Slow hue cycle through the aurora palette.
    const span = Number.isFinite(time) ? time / 7 : 0;
    const i = ((Math.floor(span) % AURORA.length) + AURORA.length) % AURORA.length;
    const tint = mix(AURORA[i], AURORA[(i + 1) % AURORA.length], span - Math.floor(span));
    const near = mix(DEEP, tint, 0.13);
    const mid = mix(DEEP, tint, 0.04);

    this.#skyFill.setStops(
      [0, [near[0], near[1], near[2], 255]],
      [0.45, [mid[0], mid[1], mid[2], 255]],
      [1, [NIGHT[0], NIGHT[1], NIGHT[2], 255]],
    );
    this.#sky.fill(this.#skyFill);

    for (const orb of this.#orbs) {
      const wave = time * 0.5 + orb.phase;
      const hue = mix(AURORA[orb.hue], tint, 0.5);
      const alpha = 26 + Math.sin(wave) * 12;

      orb.fill.setStops(
        [0, [hue[0], hue[1], hue[2], Math.max(0, Math.round(alpha))]],
        [0.45, [hue[0], hue[1], hue[2], Math.max(0, Math.round(alpha * 0.4))]],
        [1, [hue[0], hue[1], hue[2], 0]],
      );
      orb.shape.fill(orb.fill);
      orb.shape.translate(orb.x + Math.sin(wave * 0.6) * 90, orb.y + Math.cos(wave * 0.4) * 70);
    }
  }
}
