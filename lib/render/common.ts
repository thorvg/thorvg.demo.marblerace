/** Shared drawing helpers: the world-to-canvas view and reusable paint pools. */

import type { Scene, Shape, ThorVGNamespace } from '@thorvg/webcanvas';
import type { CameraView } from '../camera';
import { COURSE } from '../course';
import type { RGB } from '../types';

export interface Viewport {
  width: number;
  height: number;
}

/** Uniform scale plus offset, the only transform any layer needs. */
export interface View {
  scale: number;
  ox: number;
  oy: number;
}

export function applyView(scene: Scene, view: View): void {
  scene.transform({
    e11: view.scale,
    e12: 0,
    e13: view.ox,
    e21: 0,
    e22: view.scale,
    e23: view.oy,
    e31: 0,
    e32: 0,
    e33: 1,
  });
}

/**
 * World space seen through the race camera. `parallax` below 1 makes a layer
 * drift slower than the track, which reads as depth.
 */
/** Canvas pixels per world unit at zoom 1. */
export function baseScale(viewport: Viewport): number {
  return Math.min(viewport.width / COURSE.viewWidth, viewport.height / COURSE.viewHeight);
}

export function cameraView(camera: CameraView, viewport: Viewport, parallax = 1): View {
  const scale = baseScale(viewport) * camera.zoom;
  return {
    scale,
    ox: viewport.width / 2 - camera.x * scale * parallax,
    oy: viewport.height / 2 - camera.y * scale * parallax,
  };
}

/** Screen space: one canvas pixel per unit. */
export function screenView(): View {
  return { scale: 1, ox: 0, oy: 0 };
}

/** A 760 x 1120 design box letterboxed into the canvas, for full screen overlays. */
export function fitView(viewport: Viewport, boxWidth = 760, boxHeight = 1120): View {
  const scale = Math.min(viewport.width / boxWidth, viewport.height / boxHeight);
  return {
    scale,
    ox: (viewport.width - boxWidth * scale) / 2,
    oy: (viewport.height - boxHeight * scale) / 2,
  };
}

/** A grow-once, reuse-forever pool of shapes living in one scene. */
export class ShapePool {
  #tvg: ThorVGNamespace;
  #scene: Scene;
  #blend?: number;
  #shapes: Shape[] = [];
  #used = 0;

  constructor(tvg: ThorVGNamespace, scene: Scene, blend?: number) {
    this.#tvg = tvg;
    this.#scene = scene;
    this.#blend = blend;
  }

  begin(): void {
    this.#used = 0;
  }

  next(): Shape {
    let shape = this.#shapes[this.#used];
    if (!shape) {
      shape = new this.#tvg.Shape();
      if (this.#blend !== undefined) shape.blend(this.#blend);
      this.#scene.add(shape);
      this.#shapes.push(shape);
    }
    this.#used++;
    shape.reset();
    shape.opacity(255);
    return shape;
  }

  /**
   * Unused shapes are emptied rather than hidden: an empty path draws nothing
   * and, unlike toggling visibility, never touches paints without render data.
   */
  finish(): void {
    for (let i = this.#used; i < this.#shapes.length; i++) this.#shapes[i].reset();
  }
}

const ALPHA_STEP = 32;

function bucket(alpha: number): number {
  return Math.max(ALPHA_STEP, Math.min(255, Math.round(alpha / ALPHA_STEP) * ALPHA_STEP));
}

/**
 * Batches particles that share a colour into a single shape. Hundreds of
 * sparks or confetti quads collapse into a handful of paints per frame.
 */
export class ColorPool {
  #tvg: ThorVGNamespace;
  #scene: Scene;
  #blend?: number;
  #shapes = new Map<string, Shape>();
  #active = new Set<Shape>();

  constructor(tvg: ThorVGNamespace, scene: Scene, blend?: number) {
    this.#tvg = tvg;
    this.#scene = scene;
    this.#blend = blend;
  }

  begin(): void {
    this.#active.clear();
  }

  shape(color: RGB, alpha: number): Shape {
    const a = bucket(alpha);
    const key = `${color[0]},${color[1]},${color[2]},${a}`;
    let shape = this.#shapes.get(key);
    if (!shape) {
      shape = new this.#tvg.Shape();
      if (this.#blend !== undefined) shape.blend(this.#blend);
      this.#scene.add(shape);
      this.#shapes.set(key, shape);
    }
    if (!this.#active.has(shape)) {
      shape.reset();
      shape.fill(color[0], color[1], color[2], a);
      this.#active.add(shape);
    }
    return shape;
  }

  finish(): void {
    for (const shape of this.#shapes.values()) {
      if (!this.#active.has(shape)) shape.reset();
    }
  }
}

/** Appends an axis-aligned rectangle rotated around its own centre. */
export function addRotatedRect(shape: Shape, cx: number, cy: number, w: number, h: number, rot: number): void {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const hw = w / 2;
  const hh = h / 2;
  const px = [-hw, hw, hw, -hw];
  const py = [-hh, -hh, hh, hh];

  for (let i = 0; i < 4; i++) {
    const x = cx + px[i] * cos - py[i] * sin;
    const y = cy + px[i] * sin + py[i] * cos;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.close();
}

/** Four point sparkle star: tips and concave mid points, straight segments. */
export function addStar(shape: Shape, cx: number, cy: number, size: number, rot: number): void {
  const inner = size * 0.16;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const point = (dx: number, dy: number): [number, number] => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];

  const tips: Array<[number, number]> = [point(0, -size), point(size, 0), point(0, size), point(-size, 0)];
  const mids: Array<[number, number]> = [point(inner, -inner), point(inner, inner), point(-inner, inner), point(-inner, -inner)];

  shape.moveTo(tips[0][0], tips[0][1]);
  for (let i = 0; i < 4; i++) {
    const mid = mids[i];
    const tip = tips[(i + 1) % 4];
    shape.lineTo(mid[0], mid[1]);
    shape.lineTo(tip[0], tip[1]);
  }
  shape.close();
}

/** Straight capsule between two points, used for the board rails. */
export function addCapsule(shape: Shape, x1: number, y1: number, x2: number, y2: number, width: number): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  const ex = (dx / len) * (width / 2);
  const ey = (dy / len) * (width / 2);

  shape.moveTo(x1 + nx - ex, y1 + ny - ey);
  shape.lineTo(x2 + nx + ex, y2 + ny + ey);
  shape.lineTo(x2 - nx + ex, y2 - ny + ey);
  shape.lineTo(x1 - nx - ex, y1 - ny - ey);
  shape.close();
}

/**
 * Circle path that starts at 12 o'clock and runs clockwise, so `trimPath`
 * draws it like a stopwatch. Also keeps a stable bounding box while trimmed.
 */
export function addCircleFromTop(shape: Shape, cx: number, cy: number, r: number): void {
  const k = 0.5522847498307936 * r;
  shape.moveTo(cx, cy - r);
  shape.cubicTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
  shape.cubicTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
  shape.cubicTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
  shape.cubicTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
  shape.close();
}

/** Cubic approximation of a circular arc, at most a quarter turn. */
function arcTo(shape: Shape, cx: number, cy: number, r: number, a0: number, a1: number): void {
  const k = ((4 / 3) * Math.tan((a1 - a0) / 4)) * r;
  const c0 = Math.cos(a0);
  const s0 = Math.sin(a0);
  const c1 = Math.cos(a1);
  const s1 = Math.sin(a1);

  shape.cubicTo(
    cx + r * c0 - k * s0,
    cy + r * s0 + k * c0,
    cx + r * c1 + k * s1,
    cy + r * s1 - k * c1,
    cx + r * c1,
    cy + r * s1,
  );
}

/** Rounded capsule between two points, as a single closed path. */
export function addCapsulePath(shape: Shape, ax: number, ay: number, bx: number, by: number, r: number): void {
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.hypot(dx, dy) < 0.001) {
    // Wound the same way as the capsule below. `appendCircle` runs the other
    // way round, and under a non-zero fill a hub drawn with it cancels out
    // wherever an arm in the same shape crosses it.
    shape.moveTo(ax + r, ay);
    for (let i = 0; i < 4; i++) arcTo(shape, ax, ay, r, (-i * Math.PI) / 2, (-(i + 1) * Math.PI) / 2);
    shape.close();
    return;
  }

  const a = Math.atan2(dy, dx);
  const up = a + Math.PI / 2;
  const down = a - Math.PI / 2;

  shape.moveTo(ax + Math.cos(up) * r, ay + Math.sin(up) * r);
  shape.lineTo(bx + Math.cos(up) * r, by + Math.sin(up) * r);
  arcTo(shape, bx, by, r, up, up - Math.PI / 2);
  arcTo(shape, bx, by, r, up - Math.PI / 2, down);
  shape.lineTo(ax + Math.cos(down) * r, ay + Math.sin(down) * r);
  arcTo(shape, ax, ay, r, down, down - Math.PI / 2);
  arcTo(shape, ax, ay, r, down - Math.PI / 2, up - Math.PI);
  shape.close();
}
