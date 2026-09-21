/**
 * The track itself: side rails, peg fields, ramps, boost pads and the finish.
 *
 * Static geometry is built once and chunked into vertical bands so ThorVG can
 * cull the parts of the course that are off camera. Only the pieces that
 * animate (boost pads, finish line, peg flashes) are rebuilt per frame.
 */

import type { LinearGradient, Scene, Shape, ThorVGNamespace } from '@thorvg/webcanvas';
import { COURSE } from '../course';
import { UI, lighten } from '../palette';
import type { Course, Peg } from '../types';
import { ShapePool, addCapsulePath } from './common';

const BAND = 900;

export class CourseLayer {
  #tvg: ThorVGNamespace;
  #course: Course;
  #flashes: ShapePool;
  #boostShapes: ShapePool;
  #finishLine: Shape;
  #finishGlow: Shape;
  #finishFill: LinearGradient;
  #goalRing: Shape;
  #staticScene: Scene;
  /**
   * The baked geometry, held in one child scene. A new course, or a repaint,
   * swaps the whole scene rather than tearing the renderer down: the animated
   * paints, the marble artwork and the reveal all survive untouched.
   */
  #baked: Scene | null = null;

  constructor(tvg: ThorVGNamespace, staticScene: Scene, liveScene: Scene, course: Course) {
    this.#tvg = tvg;
    this.#course = course;
    this.#staticScene = staticScene;
    this.#flashes = new ShapePool(tvg, liveScene, tvg.BlendMethod.Add);
    this.#boostShapes = new ShapePool(tvg, liveScene);

    this.#finishGlow = new tvg.Shape();
    liveScene.add(this.#finishGlow);

    this.#finishLine = new tvg.Shape();
    this.#finishFill = new tvg.LinearGradient(COURSE.left, 0, COURSE.right, 0);
    liveScene.add(this.#finishLine);

    this.#goalRing = new tvg.Shape();
    liveScene.add(this.#goalRing);

    this.setCourse(course);
  }

  /** Re-bakes the static geometry for a new course, or for new colours. */
  setCourse(course: Course): void {
    const tvg = this.#tvg;
    this.#course = course;
    if (this.#baked) this.#staticScene.remove(this.#baked);

    const baked = new tvg.Scene();
    this.#staticScene.add(baked);
    this.#baked = baked;

    this.#buildRails(tvg, baked, course);
    this.#buildBands(tvg, baked, course);
    this.#buildFinishBed(tvg, baked, course);
  }

  #buildRails(tvg: ThorVGNamespace, scene: Scene, course: Course): void {
    const rails = new tvg.Shape();
    const fill = new tvg.LinearGradient(0, 0, 0, course.height);
    // Rails read as structure, not as a highlight: keep them below the pegs.
    fill.setStops(
      [0, [86, 99, 112, 255]],
      [0.5, [44, 52, 62, 255]],
      [1, [86, 99, 112, 255]],
    );
    addCapsulePath(rails, COURSE.left, 40, COURSE.left, course.height - 40, 7);
    addCapsulePath(rails, COURSE.right, 40, COURSE.right, course.height - 40, 7);
    rails.fill(fill);
    scene.add(rails);

    // Distance ticks: the scrolling cue that sells the speed of the descent.
    const ticks = new tvg.Shape();
    for (let y = 260; y < course.height - 200; y += 240) {
      ticks.appendRect(COURSE.left + 10, y, 26, 4, { rx: 2, ry: 2 });
      ticks.appendRect(COURSE.right - 36, y, 26, 4, { rx: 2, ry: 2 });
    }
    ticks.fill(UI.trackLight[0], UI.trackLight[1], UI.trackLight[2], 55);
    scene.add(ticks);
  }

  #buildBands(tvg: ThorVGNamespace, scene: Scene, course: Course): void {
    const bands = Math.ceil(course.height / BAND) + 1;

    for (let band = 0; band < bands; band++) {
      const top = band * BAND;
      const bottom = top + BAND;

      const pegs = course.pegs.filter((p) => p.y >= top && p.y < bottom);
      const walls = course.walls.filter((w) => Math.max(w.y1, w.y2) >= top && Math.min(w.y1, w.y2) < bottom);
      if (!pegs.length && !walls.length) continue;

      if (walls.length) {
        const rail = new tvg.Shape();
        const core = new tvg.Shape();
        for (const w of walls) {
          addCapsulePath(rail, w.x1, w.y1, w.x2, w.y2, 8);
          addCapsulePath(core, w.x1, w.y1, w.x2, w.y2, 3);
        }
        rail.fill(UI.track[0], UI.track[1], UI.track[2], 255);
        core.fill(UI.trackLight[0], UI.trackLight[1], UI.trackLight[2], 150);
        scene.add(rail);
        scene.add(core);
      }

      const plain = pegs.filter((p) => !p.bumper);
      if (plain.length) {
        const bodies = new tvg.Shape();
        const shine = new tvg.Shape();
        for (const p of plain) {
          bodies.appendCircle(p.x, p.y, p.r);
          shine.appendCircle(p.x - p.r * 0.22, p.y - p.r * 0.3, p.r * 0.58);
        }
        bodies.fill(UI.peg[0], UI.peg[1], UI.peg[2], 255).stroke({ width: 1.4, color: [16, 24, 52, 220] });
        shine.fill(UI.pegLight[0], UI.pegLight[1], UI.pegLight[2], 150);
        scene.add(bodies);
        scene.add(shine);
      }

      const bumpers = pegs.filter((p) => p.bumper);
      if (bumpers.length) {
        const bodies = new tvg.Shape();
        const shine = new tvg.Shape();
        const cap = new tvg.Shape();
        for (const p of bumpers) {
          bodies.appendCircle(p.x, p.y, p.r);
          shine.appendCircle(p.x - p.r * 0.24, p.y - p.r * 0.28, p.r * 0.62);
          cap.appendCircle(p.x, p.y, p.r * 0.26);
        }
        bodies.fill(UI.bumper[0], UI.bumper[1], UI.bumper[2], 255).stroke({ width: 2, color: [255, 236, 200, 150] });
        shine.fill(UI.bumperLight[0], UI.bumperLight[1], UI.bumperLight[2], 210);
        cap.fill(90, 44, 14, 180);
        scene.add(bodies);
        scene.add(shine);
        scene.add(cap);
      }
    }
  }

  #buildFinishBed(tvg: ThorVGNamespace, scene: Scene, course: Course): void {
    const y = course.finishY;

    const bed = new tvg.Shape();
    bed.appendRect(COURSE.left, y - 6, COURSE.right - COURSE.left, 44, { rx: 8, ry: 8 });
    bed.fill(10, 16, 36, 200);
    scene.add(bed);

    // Chequered strip.
    const dark = new tvg.Shape();
    const light = new tvg.Shape();
    const cell = 22;
    for (let i = 0; i * cell < COURSE.right - COURSE.left; i++) {
      for (let row = 0; row < 2; row++) {
        const x = COURSE.left + i * cell;
        const w = Math.min(cell, COURSE.right - x);
        const target = (i + row) % 2 === 0 ? light : dark;
        target.appendRect(x, y + row * 16, w, 16);
      }
    }
    light.fill(UI.finish[0], UI.finish[1], UI.finish[2], 190);
    dark.fill(18, 26, 54, 210);
    scene.add(dark);
    scene.add(light);
  }

  /** @param energy 0..1 flash when a marble crosses the line */
  update(time: number, energy: number): void {
    const course = this.#course;
    const y = course.finishY;
    const sweep = (time * 0.35) % 1;

    // Animated gradient sweeping along the finish line.
    this.#finishFill.setStops(
      [0, [UI.gold[0], UI.gold[1], UI.gold[2], 120]],
      [Math.max(0.001, sweep * 0.98), [255, 255, 255, 235]],
      [1, [UI.gold[0], UI.gold[1], UI.gold[2], 120]],
    );
    this.#finishLine.reset();
    this.#finishLine.appendRect(COURSE.left, y - 4, COURSE.right - COURSE.left, 5, { rx: 2.5, ry: 2.5 });
    this.#finishLine.fill(this.#finishFill);

    const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
    this.#finishGlow.reset();
    this.#finishGlow
      .appendRect(COURSE.left, y - 26, COURSE.right - COURSE.left, 50, { rx: 16, ry: 16 })
      .fill(UI.gold[0], UI.gold[1], UI.gold[2], Math.round(26 + pulse * 26 + energy * 120));

    this.#goalRing.reset();
    this.#goalRing
      .appendCircle(course.goal.x, course.goal.y, course.goalRadius + Math.sin(time * 2) * 3)
      .stroke({
        width: 4 + energy * 6,
        color: [UI.goal[0], UI.goal[1], UI.goal[2], Math.round(120 + pulse * 60 + energy * 75)],
      });

    // Boost pads: chevrons scrolling downwards.
    this.#boostShapes.begin();
    for (const pad of course.boosters) {
      const body = this.#boostShapes.next();
      body
        .appendRect(pad.x, pad.y, pad.w, pad.h, { rx: 14, ry: 14 })
        .fill(UI.boost[0], UI.boost[1], UI.boost[2], 34)
        .stroke({ width: 1.5, color: [UI.boost[0], UI.boost[1], UI.boost[2], 90] });

      const arrows = this.#boostShapes.next();
      const rows = 3;
      const span = pad.h / rows;
      for (let i = 0; i < rows; i++) {
        const shift = ((time * 150 + i * span) % pad.h) - 12;
        const cy = pad.y + shift;
        if (cy < pad.y - 6 || cy > pad.y + pad.h - 10) continue;
        const midX = pad.x + pad.w / 2;
        const half = pad.w * 0.3;
        arrows.moveTo(midX - half, cy);
        arrows.lineTo(midX, cy + 18);
        arrows.lineTo(midX + half, cy);
        arrows.lineTo(midX + half - 10, cy);
        arrows.lineTo(midX, cy + 8);
        arrows.lineTo(midX - half + 10, cy);
        arrows.close();
      }
      const bright = lighten(UI.boost, 0.2);
      arrows.fill(bright[0], bright[1], bright[2], 165);
    }
    this.#boostShapes.finish();

    this.#flashes.begin();
    for (const peg of course.pegs) {
      if (peg.energy <= 0.03) continue;
      this.#drawFlash(peg);
    }
    this.#flashes.finish();
  }

  #drawFlash(peg: Peg): void {
    const e = Math.min(1, peg.energy);
    const color = peg.bumper ? UI.bumperLight : UI.pegLight;
    const ring = this.#flashes.next();
    ring
      .appendCircle(peg.x, peg.y, peg.r + 3 + (1 - e) * 16)
      .stroke({ width: 1.5 + e * 4, color: [color[0], color[1], color[2], Math.round(e * 190)] });
  }
}
