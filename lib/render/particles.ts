/** Draws the particle systems. Sparks/confetti are batched by colour. */

import type { Scene, ThorVGNamespace } from '@thorvg/webcanvas';
import type { Fx } from '../fx';
import { ColorPool, ShapePool, addRotatedRect, addStar } from './common';

export class ParticleLayer {
  #sparks: ColorPool;
  #waves: ShapePool;
  #confetti: ColorPool;
  #sparkles: ColorPool;

  constructor(tvg: ThorVGNamespace, belowScene: Scene, aboveScene: Scene) {
    this.#sparks = new ColorPool(tvg, belowScene, tvg.BlendMethod.Add);
    this.#waves = new ShapePool(tvg, aboveScene, tvg.BlendMethod.Add);
    this.#confetti = new ColorPool(tvg, aboveScene);
    this.#sparkles = new ColorPool(tvg, aboveScene, tvg.BlendMethod.Add);
  }

  update(fx: Fx): void {
    this.#sparks.begin();
    for (const p of fx.sparks) {
      const t = p.life / p.max;
      const shape = this.#sparks.shape(p.color, 40 + t * 215);
      shape.appendCircle(p.x, p.y, Math.max(0.6, p.size * (0.35 + t * 0.65)));
    }
    this.#sparks.finish();

    this.#waves.begin();
    for (const w of fx.waves) {
      const t = w.life / w.max;
      const alpha = Math.round(t * t * 235);
      if (alpha < 6) continue;
      const shape = this.#waves.next();
      shape
        .appendCircle(w.x, w.y, w.r)
        .stroke({ width: Math.max(0.5, w.width * t), color: [w.color[0], w.color[1], w.color[2], alpha] });
    }
    this.#waves.finish();

    this.#confetti.begin();
    for (const c of fx.confetti) {
      const fade = Math.min(1, c.life / 0.7);
      // |cos(flip)| squashes the quad as it tumbles, reading as paper.
      const w = Math.max(1.2, c.w * Math.abs(Math.cos(c.flip)));
      const shape = this.#confetti.shape(c.color, Math.round(fade * 255));
      addRotatedRect(shape, c.x, c.y, w, c.h, c.rot);
    }
    this.#confetti.finish();

    this.#sparkles.begin();
    for (const s of fx.sparkles) {
      const t = s.life / s.max;
      const grow = Math.sin(Math.min(1, 1 - t) * Math.PI);
      const alpha = Math.round(Math.sin(t * Math.PI) * 255);
      if (alpha < 8) continue;
      const shape = this.#sparkles.shape(s.color, alpha);
      addStar(shape, s.x, s.y, s.size * (0.35 + grow * 0.75), s.rot);
    }
    this.#sparkles.finish();
  }
}
