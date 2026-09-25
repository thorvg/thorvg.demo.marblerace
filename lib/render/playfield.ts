/**
 * The painted playfield under the track, baked once per course. Lamps are
 * baked unlit; the course layer lights them and the 3D preview reuses the plan.
 */

import type { Scene, Shape, ThorVGNamespace } from '@thorvg/webcanvas';
import { COURSE } from '../course';
import { darken } from '../palette';
import { mulberry32, type Rng } from '../rng';
import type { Course, RGB } from '../types';
import { addCapsulePath, addStar } from './common';

export interface Lamp {
  x: number;
  y: number;
  r: number;
  color: RGB;
  kind: 'dot' | 'arrow';
  phase: number;
  period: number;
}

const INK: RGB = [14, 20, 54];
const INK_LIGHT: RGB = [34, 50, 118];

export const LAMP_COLORS: readonly RGB[] = [
  [255, 206, 64],
  [255, 76, 58],
  [70, 200, 255],
  [120, 240, 120],
  [255, 140, 40],
];

const CABINET = 700;
const SURROUND = 1400;

export interface PlayfieldPlan {
  lamps: Lamp[];
}

const LAMP_ON = 0.34;

function courseRng(course: Course, salt: number): Rng {
  return mulberry32(Math.round(course.height) * 2654435761 + course.pegs.length * 97 + salt);
}

/** Pure data, so the flat board and the 3D preview lay the same lamps. */
export function planPlayfield(course: Course): PlayfieldPlan {
  const rng = courseRng(course, 1);
  const lamps: Lamp[] = [];
  const top = 220;
  const bottom = course.finishY - 120;
  placeArrows(course, rng, top, bottom, lamps);
  placeLaneLamps(top, bottom, lamps);
  return { lamps };
}

export function lampGlow(lamp: Lamp, time: number): number {
  const t = (((time + lamp.phase) / lamp.period) % 1 + 1) % 1;
  return t < LAMP_ON ? 1 - t / LAMP_ON : 0;
}

export function buildPlayfield(tvg: ThorVGNamespace, scene: Scene, course: Course, plan: PlayfieldPlan): void {
  const rng = courseRng(course, 2);

  buildCabinet(tvg, scene, course);
  buildInk(tvg, scene, course, rng);
  buildStars(tvg, scene, course, rng);
  buildPlanets(tvg, scene, course, rng);
  buildStarburst(tvg, scene, course);
  bakeLamps(tvg, scene, plan.lamps);
}

const BAND = 900;

/** Shapes split into horizontal bands so ThorVG can cull the ones off camera. */
class Banded {
  #tvg: ThorVGNamespace;
  #scene: Scene;
  #style: (shape: Shape) => void;
  #bands = new Map<number, Shape>();

  constructor(tvg: ThorVGNamespace, scene: Scene, style: (shape: Shape) => void) {
    this.#tvg = tvg;
    this.#scene = scene;
    this.#style = style;
  }

  at(y: number): Shape {
    const band = Math.floor(y / BAND);
    let shape = this.#bands.get(band);
    if (!shape) {
      shape = new this.#tvg.Shape();
      this.#bands.set(band, shape);
    }
    return shape;
  }

  finish(): void {
    for (const shape of this.#bands.values()) {
      this.#style(shape);
      this.#scene.add(shape);
    }
  }
}

/* -------------------------------------------------------------- art */

function buildInk(tvg: ThorVGNamespace, scene: Scene, course: Course, rng: Rng): void {
  const width = COURSE.right - COURSE.left;

  const base = new tvg.Shape();
  const fill = new tvg.LinearGradient(COURSE.left, 0, COURSE.right, 0);
  fill.setStops(
    [0, [...darken(INK, 0.35), 255]],
    [0.5, [...INK, 255]],
    [1, [...darken(INK, 0.35), 255]],
  );
  base.appendRect(COURSE.left, 0, width, course.height).fill(fill);
  scene.add(base);

  for (let y = 200; y < course.height; y += 420 + rng() * 260) {
    const x = COURSE.left + width * (0.2 + rng() * 0.6);
    const r = 170 + rng() * 170;
    const pool = new tvg.Shape();
    const glow = new tvg.RadialGradient(x, y, r);
    glow.setStops([0, [...INK_LIGHT, 150]], [0.55, [...INK_LIGHT, 50]], [1, [...INK_LIGHT, 0]]);
    pool.appendCircle(x, y, r).fill(glow);
    scene.add(pool);
  }
}

function buildStars(tvg: ThorVGNamespace, scene: Scene, course: Course, rng: Rng): void {
  const faint = new Banded(tvg, scene, (shape) => shape.fill(170, 190, 255, 70));
  const bright = new Banded(tvg, scene, (shape) => shape.fill(220, 230, 255, 150));
  const sparkles = new Banded(tvg, scene, (shape) => shape.fill(235, 240, 255, 170));
  const width = COURSE.right - COURSE.left;
  const count = Math.round(course.height / 9);
  for (let i = 0; i < count; i++) {
    const x = COURSE.left + rng() * width;
    const y = rng() * course.height;
    const roll = rng();
    if (roll < 0.03) addStar(sparkles.at(y), x, y, 5 + rng() * 5, rng() * Math.PI);
    else if (roll < 0.25) bright.at(y).appendCircle(x, y, 1 + rng() * 0.8);
    else faint.at(y).appendCircle(x, y, 0.6 + rng() * 0.6);
  }
  faint.finish();
  bright.finish();
  sparkles.finish();
}

const PLANETS: ReadonlyArray<{ light: RGB; body: RGB; dark: RGB }> = [
  { light: [255, 200, 130], body: [220, 110, 50], dark: [70, 20, 20] },
  { light: [220, 170, 255], body: [130, 70, 200], dark: [30, 14, 60] },
  { light: [170, 255, 240], body: [40, 160, 170], dark: [8, 40, 60] },
];

function buildPlanets(tvg: ThorVGNamespace, scene: Scene, course: Course, rng: Rng): void {
  const stars = new Banded(tvg, scene, (shape) => shape.fill(200, 214, 255, 110));
  for (let y = -CABINET; y < course.height + CABINET; y += 22) {
    for (const side of [-1, 1]) {
      if (rng() < 0.55) continue;
      const reach = 40 + rng() * (SURROUND - 40);
      const x = side < 0 ? -reach : COURSE.width + reach;
      stars.at(y).appendCircle(x, y + rng() * 22, 0.6 + rng() * 1.1);
    }
  }
  stars.finish();

  let i = Math.floor(rng() * PLANETS.length);
  for (let y = 300 + rng() * 400; y < course.height; y += 700 + rng() * 500, i++) {
    const tone = PLANETS[i % PLANETS.length];
    const r = 60 + rng() * 70;
    const left = i % 2 === 0;
    const gap = r * 2 + 60 + rng() * 220;
    const x = left ? -gap : COURSE.width + gap;
    const tilt = (left ? -1 : 1) * (14 + rng() * 14);

    const ringBack = new tvg.Shape();
    ringBack.appendCircle(0, 0, r * 1.75, r * 0.42).stroke({ width: r * 0.12, color: [...tone.light, 70] });
    ringBack.rotate(tilt).translate(x, y);
    scene.add(ringBack);

    const fill = new tvg.RadialGradient(x, y, r, x - r * 0.4, y - r * 0.45, 0);
    fill.setStops([0, [...tone.light, 235]], [0.45, [...tone.body, 225]], [1, [...tone.dark, 215]]);
    const planet = new tvg.Shape();
    planet.appendCircle(x, y, r).fill(fill);
    scene.add(planet);

    const ringFront = new tvg.Shape();
    ringFront
      .moveTo(-r * 1.75, 0)
      .cubicTo(-r * 1.75, r * 0.58, r * 1.75, r * 0.58, r * 1.75, 0)
      .stroke({ width: r * 0.12, color: [...tone.light, 150] });
    ringFront.rotate(tilt).translate(x, y);
    scene.add(ringFront);
  }
}

function buildStarburst(tvg: ThorVGNamespace, scene: Scene, course: Course): void {
  const cx = (COURSE.left + COURSE.right) / 2;
  const cy = course.finishY + 20;
  const reach = 560;
  const rays = 11;
  const light = new tvg.Shape();
  const deep = new tvg.Shape();

  for (let i = 0; i < rays; i++) {
    const a0 = Math.PI + (i / rays) * Math.PI;
    const a1 = Math.PI + ((i + 1) / rays) * Math.PI;
    const mid = (a0 + a1) / 2;
    const target = i % 2 === 0 ? light : deep;
    target.moveTo(cx, cy);
    target.lineTo(cx + Math.cos(a0) * reach, cy + Math.sin(a0) * reach);
    target.lineTo(cx + Math.cos(mid) * reach * 1.08, cy + Math.sin(mid) * reach * 1.08);
    target.lineTo(cx + Math.cos(a1) * reach, cy + Math.sin(a1) * reach);
    target.close();
  }

  const fade = (r: number, g: number, b: number, a: number) => {
    const fill = new tvg.RadialGradient(cx, cy, reach * 1.08);
    fill.setStops([0, [r, g, b, a]], [0.55, [r, g, b, Math.round(a * 0.45)]], [1, [r, g, b, 0]]);
    return fill;
  };
  light.fill(fade(150, 80, 230, 150));
  deep.fill(fade(80, 36, 160, 120));
  scene.add(light);
  scene.add(deep);
}

function buildCabinet(tvg: ThorVGNamespace, scene: Scene, course: Course): void {
  const top = -CABINET;
  const bottom = course.height + CABINET;

  for (const side of [-1, 1] as const) {
    const inner = side < 0 ? COURSE.left - 6 : COURSE.right + 6;
    const edge = side < 0 ? 0 : COURSE.width;
    const width = Math.abs(edge - inner);

    const surround = new tvg.Shape();
    const dark = new tvg.LinearGradient(edge, 0, edge + side * SURROUND, 0);
    dark.setStops(
      [0, [30, 26, 52, 255]],
      [0.18, [16, 16, 34, 255]],
      [0.6, [7, 8, 16, 255]],
      [1, [3, 3, 7, 255]],
    );
    surround.appendRect(side < 0 ? edge - SURROUND : edge, top, SURROUND, bottom - top).fill(dark);
    scene.add(surround);

    for (let y = side < 0 ? 300 : 750; y < course.height; y += 900) {
      const x = edge + side * 150;
      const pool = new tvg.Shape();
      const warm = new tvg.RadialGradient(x, y, 190);
      warm.setStops([0, [255, 226, 180, 200]], [0.08, [255, 170, 110, 120]], [0.4, [150, 60, 60, 40]], [1, [60, 20, 40, 0]]);
      pool.appendCircle(x, y, 190).fill(warm);
      scene.add(pool);
    }

    const wood = new tvg.Shape();
    const grain = new tvg.LinearGradient(inner, 0, edge, 0);
    grain.setStops(
      [0, [196, 92, 58, 255]],
      [0.14, [132, 50, 32, 255]],
      [0.55, [84, 28, 20, 255]],
      [0.9, [46, 14, 12, 255]],
      [1, [120, 62, 44, 255]],
    );
    wood.appendRect(Math.min(inner, edge), top, width, bottom - top).fill(grain);
    scene.add(wood);

    const bolts = new tvg.Shape();
    const inserts = new tvg.Shape();
    const mid = (inner + edge) / 2;
    for (let y = 160; y < course.height; y += 240) {
      bolts.appendCircle(mid, y, 3);
      addCapsulePath(inserts, mid, y + 104, mid, y + 150, 3.2);
    }
    bolts.fill(214, 218, 226, 230).stroke({ width: 1, color: [40, 16, 14, 200] });
    inserts.fill(255, 196, 70, 170);
    scene.add(bolts);
    scene.add(inserts);
  }
}

/* ------------------------------------------------------------ lamps */

function clearOf(course: Course, x: number, y: number, radius: number): boolean {
  for (const p of course.pegs) {
    if (Math.abs(p.y - y) < radius + p.r && Math.hypot(p.x - x, p.y - y) < radius + p.r) return false;
  }
  for (const o of course.obstacles) {
    if (Math.hypot(o.pivotX - x, o.pivotY - y) < radius + o.reach) return false;
  }
  for (const w of course.walls) {
    if (segmentDistance(x, y, w.x1, w.y1, w.x2, w.y2) < radius + 10) return false;
  }
  return true;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function placeArrows(course: Course, rng: Rng, top: number, bottom: number, lamps: Lamp[]): void {
  for (let tries = 0; tries < 120; tries++) {
    const x = COURSE.left + 70 + rng() * (COURSE.right - COURSE.left - 140);
    const y = top + rng() * (bottom - top);
    if (!clearOf(course, x, y + 40, 60)) continue;
    if (lamps.some((l) => Math.hypot(l.x - x, l.y - y) < 150)) continue;

    const color = rng() < 0.5 ? LAMP_COLORS[0] : LAMP_COLORS[1];
    for (let i = 0; i < 3; i++) {
      lamps.push({ x, y: y + i * 30, r: 12 - i * 1.5, color, kind: 'arrow', phase: i * 0.22, period: 0.9 });
    }
  }
}

function placeLaneLamps(top: number, bottom: number, lamps: Lamp[]): void {
  let i = 0;
  for (let y = top; y < bottom; y += 96, i++) {
    const color = LAMP_COLORS[i % 4];
    lamps.push({ x: COURSE.left + 22, y, r: 5, color, kind: 'dot', phase: i * 0.16, period: 1.6 });
    lamps.push({ x: COURSE.right - 22, y: y + 48, r: 5, color, kind: 'dot', phase: i * 0.16 + 0.08, period: 1.6 });
  }
}

export function addLamp(shape: Shape, lamp: Lamp, scale = 1): void {
  const r = lamp.r * scale;
  if (lamp.kind === 'dot') {
    shape.appendCircle(lamp.x, lamp.y, r);
    return;
  }
  shape.moveTo(lamp.x - r, lamp.y - r * 0.55);
  shape.lineTo(lamp.x + r, lamp.y - r * 0.55);
  shape.lineTo(lamp.x, lamp.y + r * 0.85);
  shape.close();
}

function bakeLamps(tvg: ThorVGNamespace, scene: Scene, lamps: Lamp[]): void {
  const bezel = new Banded(tvg, scene, (shape) => shape.fill(6, 8, 20, 220));
  for (const lamp of lamps) addLamp(bezel.at(lamp.y), lamp, 1.28);
  bezel.finish();

  const glass = new Map<string, Banded>();
  const shine = new Banded(tvg, scene, (shape) => shape.fill(255, 255, 255, 40));
  for (const lamp of lamps) {
    const key = lamp.color.join(',');
    let tint = glass.get(key);
    if (!tint) {
      const dim = darken(lamp.color, 0.62);
      tint = new Banded(tvg, scene, (shape) => shape.fill(dim[0], dim[1], dim[2], 255));
      glass.set(key, tint);
    }
    addLamp(tint.at(lamp.y), lamp);
    if (lamp.kind === 'dot') shine.at(lamp.y).appendCircle(lamp.x - lamp.r * 0.3, lamp.y - lamp.r * 0.34, lamp.r * 0.34);
  }
  for (const tint of glass.values()) tint.finish();
  shine.finish();
}
