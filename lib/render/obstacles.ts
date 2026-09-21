/**
 * Moving obstacles: spinner arms, pendulums and sliding bars.
 *
 * Everything is rebuilt each frame from the obstacle transforms, batched by
 * colour into a handful of paints. A faint copy at the previous angle acts as
 * a motion blur so fast spinners read as fast.
 */

import type { Scene, ThorVGNamespace } from '@thorvg/webcanvas';
import { UI, darken, lighten } from '../palette';
import type { Course, Obstacle, RGB } from '../types';
import { ColorPool, addCapsulePath } from './common';

const GHOST_STEP = 0.075;

export class ObstacleLayer {
  #pool: ColorPool;

  constructor(tvg: ThorVGNamespace, scene: Scene) {
    this.#pool = new ColorPool(tvg, scene);
  }

  update(course: Course, cameraY: number, viewHeight: number): void {
    const top = cameraY - viewHeight * 0.6;
    const bottom = cameraY + viewHeight * 0.6;

    this.#pool.begin();

    for (const o of course.obstacles) {
      if (o.pivotY + o.reach < top || o.pivotY - o.reach > bottom) continue;

      const base: RGB = o.hot ? UI.hot : UI.machine;
      const shell = darken(base, 0.35);

      if (Math.abs(o.spin) > 0.2) {
        this.#paint(o, o.angle - o.spin * GHOST_STEP, this.#pool.shape(base, 34), 1);
      }
      this.#paint(o, o.angle, this.#pool.shape(shell, 255), 1);
      this.#paint(o, o.angle, this.#pool.shape(base, 255), 0.62);
      this.#paint(o, o.angle, this.#pool.shape(lighten(base, 0.55), 210), 0.24);
    }

    this.#pool.finish();
  }

  /** Draws every part of an obstacle at `angle`, with radii scaled by `weight`. */
  #paint(o: Obstacle, angle: number, shape: ReturnType<ColorPool['shape']>, weight: number): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const px = o.pivotX + o.ox;
    const py = o.pivotY + o.oy;

    for (const part of o.parts) {
      if (part.kind === 'circle') {
        shape.appendCircle(px + part.cx * cos - part.cy * sin, py + part.cx * sin + part.cy * cos, part.r * weight);
        continue;
      }
      addCapsulePath(
        shape,
        px + part.ax * cos - part.ay * sin,
        py + part.ax * sin + part.ay * cos,
        px + part.bx * cos - part.by * sin,
        py + part.bx * sin + part.by * cos,
        Math.max(1, part.r * weight),
      );
    }
  }
}
