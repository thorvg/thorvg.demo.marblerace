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
import { ColorPool, addCapsulePath, addExtrudedCapsule } from './common';

const GHOST_STEP = 0.075;
const DEPTH = 8;

const SHINE_X = -0.28;
const SHINE_Y = -0.34;

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

      if (Math.abs(o.spin) > 0.2) {
        this.#paint(o, o.angle - o.spin * GHOST_STEP, this.#pool.shape(base, 40), 1);
      }
      this.#paint(o, o.angle, this.#pool.shape(darken(base, 0.62), 255), 1, 0, DEPTH);
      this.#paint(o, o.angle, this.#pool.shape(darken(base, 0.4), 255), 1);
      this.#paint(o, o.angle, this.#pool.shape(darken(base, 0.1), 255), 0.84);
      this.#paint(o, o.angle, this.#pool.shape(lighten(base, 0.18), 255), 0.5, 0.2);
      this.#paint(o, o.angle, this.#pool.shape(lighten(base, 0.75), 200), 0.14, 0.7);
    }

    this.#pool.finish();
  }

  #paint(
    o: Obstacle,
    angle: number,
    shape: ReturnType<ColorPool['shape']>,
    weight: number,
    shine = 0,
    depth = 0,
  ): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const px = o.pivotX + o.ox;
    const py = o.pivotY + o.oy;

    for (const part of o.parts) {
      const dx = part.r * shine * SHINE_X;
      const dy = part.r * shine * SHINE_Y;
      const r = Math.max(1, part.r * weight);
      if (part.kind === 'circle') {
        // A zero length capsule, wound like the arms, so a hub never cancels out where an arm crosses it.
        const cx = px + part.cx * cos - part.cy * sin + dx;
        const cy = py + part.cx * sin + part.cy * cos + dy;
        if (depth > 0) addCapsulePath(shape, cx, cy, cx, cy + depth, r);
        else addCapsulePath(shape, cx, cy, cx, cy, r);
        continue;
      }
      const ax = px + part.ax * cos - part.ay * sin + dx;
      const ay = py + part.ax * sin + part.ay * cos + dy;
      const bx = px + part.bx * cos - part.by * sin + dx;
      const by = py + part.bx * sin + part.by * cos + dy;
      if (depth > 0) addExtrudedCapsule(shape, ax, ay, bx, by, r, depth);
      else addCapsulePath(shape, ax, ay, bx, by, r);
    }
  }
}
