/**
 * The track itself: side rails, peg fields, ramps, boost pads and the finish.
 *
 * Static geometry is built once and chunked into vertical bands so ThorVG can
 * cull the parts of the course that are off camera. Only the pieces that
 * animate (boost pads, finish line, peg flashes) are rebuilt per frame.
 */

import type { LinearGradient, Scene, Shape, ThorVGNamespace } from '@thorvg/webcanvas';
import { COURSE } from '../course';
import { UI, darken, lighten } from '../palette';
import type { Course, Peg, RGB } from '../types';
import { ColorPool, ShapePool, addCapsulePath, addExtrudedCapsule, addRotatedRect } from './common';
import { addLamp, buildPlayfield, lampGlow, planPlayfield, type Lamp } from './playfield';

const BAND = 900;
const WALL_DEPTH = 9;
const WALL_R = 9;
const WALL_SIDE: RGB = [74, 14, 12];
const INSERT_STEP = 64;

const GLOW_REACH = 46;

export class CourseLayer {
  #tvg: ThorVGNamespace;
  #course: Course;
  #flashes: ShapePool;
  #boostShapes: ShapePool;
  #finishLine: Shape;
  #finishGlow: Shape;
  #finishGlowFill: LinearGradient;
  #finishFill: LinearGradient;
  #goalRing: Shape;
  #lamps: Lamp[] = [];
  #lit: ColorPool;
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
    this.#lit = new ColorPool(tvg, liveScene);

    this.#flashes = new ShapePool(tvg, liveScene, tvg.BlendMethod.Add);
    this.#boostShapes = new ShapePool(tvg, liveScene);

    this.#finishGlow = new tvg.Shape();
    this.#finishGlowFill = new tvg.LinearGradient(0, 0, 0, 1);
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

    const plan = planPlayfield(course);
    this.#lamps = plan.lamps;
    buildPlayfield(tvg, baked, course, plan);
    this.#buildRails(tvg, baked, course);
    this.#buildBands(tvg, baked, course);
    this.#buildFinishBed(tvg, baked, course);

    const y = course.finishY;
    const gold = UI.gold;
    this.#finishGlowFill = new tvg.LinearGradient(0, y - GLOW_REACH, 0, y + GLOW_REACH);
    this.#finishGlowFill.setStops(
      [0, [gold[0], gold[1], gold[2], 0]],
      [0.35, [gold[0], gold[1], gold[2], 22]],
      [0.5, [gold[0], gold[1], gold[2], 70]],
      [0.65, [gold[0], gold[1], gold[2], 22]],
      [1, [gold[0], gold[1], gold[2], 0]],
    );
  }

  #buildRails(tvg: ThorVGNamespace, scene: Scene, course: Course): void {
    const top = 40;
    const bottom = course.height - 40;

    for (const x of [COURSE.left, COURSE.right]) {
      const rail = new tvg.Shape();
      const fill = new tvg.LinearGradient(x - 7, 0, x + 7, 0);
      fill.setStops(
        [0, [34, 40, 49, 255]],
        [0.3, [150, 166, 182, 255]],
        [0.5, [96, 110, 125, 255]],
        [0.85, [44, 52, 62, 255]],
        [1, [26, 31, 38, 255]],
      );
      addCapsulePath(rail, x, top, x, bottom, 7);
      rail.fill(fill);
      scene.add(rail);
    }
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
        const side = new tvg.Shape();
        const inserts = new tvg.Shape();
        for (const w of walls) addExtrudedCapsule(side, w.x1, w.y1, w.x2, w.y2, WALL_R, WALL_DEPTH);
        side.fill(...WALL_SIDE, 255).stroke({ width: 1.2, color: [18, 4, 4, 255] });
        scene.add(side);
        for (const w of walls) {
          scene.add(metalTop(tvg, w.x1, w.y1, w.x2, w.y2, WALL_R));
          const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
          const count = Math.floor(len / INSERT_STEP);
          const rot = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
          for (let i = 1; i < count; i++) {
            const t = i / count;
            addRotatedRect(inserts, w.x1 + (w.x2 - w.x1) * t, w.y1 + (w.y2 - w.y1) * t, 12, 4.2, rot);
          }
        }
        inserts.fill(255, 204, 40, 235);
        scene.add(inserts);
      }

      for (const p of pegs) {
        if (p.bumper) popBumper(tvg, scene, p);
        else scene.add(chromePost(tvg, p));
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
  update(time: number, energy: number, cameraY: number, viewHeight: number): void {
    this.#drawLamps(time, cameraY - viewHeight * 0.6, cameraY + viewHeight * 0.6);

    const course = this.#course;
    const y = course.finishY;
    const sweep = (time * 0.35) % 1;

    const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);

    // Animated gradient sweeping along the finish line.
    this.#finishFill.setStops(
      [0, [UI.gold[0], UI.gold[1], UI.gold[2], 120]],
      [Math.max(0.001, sweep * 0.98), [255, 255, 255, 235]],
      [1, [UI.gold[0], UI.gold[1], UI.gold[2], 120]],
    );
    this.#finishLine.reset();
    this.#finishLine.appendRect(COURSE.left, y - 4, COURSE.right - COURSE.left, 5, { rx: 2.5, ry: 2.5 });
    this.#finishLine.fill(this.#finishFill);

    this.#finishGlow.reset();
    this.#finishGlow
      .appendRect(COURSE.left, y - GLOW_REACH, COURSE.right - COURSE.left, GLOW_REACH * 2)
      .fill(this.#finishGlowFill)
      .opacity(Math.round(Math.min(255, 120 + pulse * 60 + energy * 255)));

    const goalR = course.goalRadius + Math.sin(time * 2) * 3;
    this.#goalRing.reset();
    this.#goalRing
      .appendCircle(course.goal.x, course.goal.y, goalR)
      .stroke({
        width: 4 + energy * 6,
        color: [UI.goal[0], UI.goal[1], UI.goal[2], Math.round(120 + pulse * 60 + energy * 75)],
      });

    this.#boostShapes.begin();
    const dim = darken(UI.boost, 0.6);
    const bright = lighten(UI.boost, 0.35);
    for (const pad of course.boosters) {
      this.#boostShapes
        .next()
        .appendRect(pad.x, pad.y, pad.w, pad.h, { rx: 12, ry: 12 })
        .fill(4, 16, 18, 215)
        .stroke({ width: 2, color: [UI.boost[0], UI.boost[1], UI.boost[2], 150] });

      const rows = 3;
      const step = pad.h / rows;
      const half = Math.min(pad.w * 0.34, step * 1.1);
      const unlit = this.#boostShapes.next();
      const lit = this.#boostShapes.next();
      const beat = (time * 2.6) % rows;
      for (let i = 0; i < rows; i++) {
        const cy = pad.y + step * (i + 0.2);
        const on = Math.max(0, 1 - Math.abs(beat - i) * 1.4);
        const target = on > 0.25 ? lit : unlit;
        addChevron(target, pad.x + pad.w / 2, cy, half, step * 0.62);
      }
      unlit.fill(dim[0], dim[1], dim[2], 255);
      lit.fill(bright[0], bright[1], bright[2], 255);
    }
    this.#boostShapes.finish();

    this.#flashes.begin();
    for (const peg of course.pegs) {
      if (peg.energy <= 0.03) continue;
      this.#drawFlash(peg);
    }
    this.#flashes.finish();
  }

  #drawLamps(time: number, top: number, bottom: number): void {
    this.#lit.begin();
    for (const lamp of this.#lamps) {
      if (lamp.y + lamp.r < top || lamp.y - lamp.r > bottom) continue;
      const glow = lampGlow(lamp, time);
      if (glow < 0.05) continue;

      addLamp(this.#lit.shape(lamp.color, 70 * glow), lamp, 1.9);
      addLamp(this.#lit.shape(lighten(lamp.color, 0.2), 255 * glow), lamp);
      if (lamp.kind === 'dot') {
        this.#lit
          .shape(lighten(lamp.color, 0.8), 255 * glow)
          .appendCircle(lamp.x - lamp.r * 0.18, lamp.y - lamp.r * 0.22, lamp.r * 0.46);
      }
    }
    this.#lit.finish();
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

function addChevron(shape: Shape, x: number, y: number, half: number, depth: number): void {
  const t = depth * 0.42;
  shape.moveTo(x - half, y);
  shape.lineTo(x, y + depth);
  shape.lineTo(x + half, y);
  shape.lineTo(x + half, y + t * 0.2);
  shape.lineTo(x + half - t * 0.9, y + t * 0.2);
  shape.lineTo(x, y + depth - t);
  shape.lineTo(x - half + t * 0.9, y + t * 0.2);
  shape.lineTo(x - half, y + t * 0.2);
  shape.close();
}

/** Unit normal of a segment, on the side facing the light (up and left). */
function lightSide(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  let nx = -(y2 - y1) / len;
  let ny = (x2 - x1) / len;
  if (nx * -0.6 + ny * -0.8 < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

function metalTop(tvg: ThorVGNamespace, x1: number, y1: number, x2: number, y2: number, r: number): Shape {
  const n = lightSide(x1, y1, x2, y2);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const fill = new tvg.LinearGradient(mx + n.x * r, my + n.y * r, mx - n.x * r, my - n.y * r);
  fill.setStops(
    [0, [255, 170, 130, 255]],
    [0.16, [214, 72, 48, 255]],
    [0.55, [150, 32, 24, 255]],
    [1, [96, 18, 14, 255]],
  );
  const top = new tvg.Shape();
  addCapsulePath(top, x1, y1, x2, y2, r);
  return top.fill(fill).stroke({ width: 1.2, color: [30, 6, 6, 255] });
}

function chromePost(tvg: ThorVGNamespace, peg: Peg): Shape {
  const fill = new tvg.RadialGradient(peg.x, peg.y, peg.r, peg.x - peg.r * 0.38, peg.y - peg.r * 0.44, 0);
  fill.setStops(
    [0, [255, 255, 255, 255]],
    [0.18, [214, 222, 234, 255]],
    [0.5, [96, 106, 124, 255]],
    [0.82, [36, 40, 52, 255]],
    [1, [138, 150, 170, 255]],
  );
  const post = new tvg.Shape();
  post.appendCircle(peg.x, peg.y, peg.r).fill(fill).stroke({ width: 1.2, color: [8, 10, 16, 230] });
  return post;
}

function popBumper(tvg: ThorVGNamespace, scene: Scene, peg: Peg): void {
  const { x, y, r } = peg;

  const rim = new tvg.Shape();
  rim.appendCircle(x, y, r * 1.12).fill(90, 14, 10, 255).stroke({ width: 1.2, color: [10, 4, 4, 255] });
  scene.add(rim);

  const bodyFill = new tvg.RadialGradient(x, y, r, x - r * 0.3, y - r * 0.36, 0);
  bodyFill.setStops(
    [0, [255, 255, 255, 255]],
    [0.55, [226, 222, 214, 255]],
    [0.86, [150, 140, 132, 255]],
    [1, [96, 84, 80, 255]],
  );
  const body = new tvg.Shape();
  body.appendCircle(x, y, r * 0.92).fill(bodyFill);
  scene.add(body);

  const cap = UI.bumper;
  const capFill = new tvg.RadialGradient(x, y, r * 0.6, x - r * 0.2, y - r * 0.24, 0);
  const light = lighten(cap, 0.55);
  const deep = darken(cap, 0.45);
  capFill.setStops(
    [0, [light[0], light[1], light[2], 255]],
    [0.6, [cap[0], cap[1], cap[2], 255]],
    [1, [deep[0], deep[1], deep[2], 255]],
  );
  const top = new tvg.Shape();
  top.appendCircle(x, y, r * 0.6).fill(capFill).stroke({ width: 1.6, color: [255, 230, 200, 200] });
  scene.add(top);

  const jewelFill = new tvg.RadialGradient(x, y, r * 0.26, x - r * 0.08, y - r * 0.1, 0);
  jewelFill.setStops([0, [190, 230, 255, 255]], [0.5, [40, 110, 240, 255]], [1, [10, 30, 110, 255]]);
  const jewel = new tvg.Shape();
  jewel.appendCircle(x, y, r * 0.26).fill(jewelFill).stroke({ width: 1, color: [255, 255, 255, 160] });
  scene.add(jewel);

  const spec = new tvg.Shape();
  spec.appendCircle(x - r * 0.2, y - r * 0.26, r * 0.14).fill(255, 255, 255, 210);
  scene.add(spec);
}
