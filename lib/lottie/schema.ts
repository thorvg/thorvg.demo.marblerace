/**
 * The slice of the Lottie schema this exporter writes, and the builders for it.
 *
 * Everything here is plain data — no engine, no canvas — so a race can be baked
 * on a worker, on a server, or anywhere the simulation runs.
 *
 * Two conventions of the format catch people out and are handled once, here:
 * colours are 0..1 floats rather than bytes, and an animated property carries
 * bezier handles even when the motion is straight, so `linear()` supplies the
 * pair that makes a cubic collapse to a line.
 */

import type { RGB } from '../types';

export type Vec = number[];

/** A property that never changes. */
export interface Fixed<T> {
  a: 0;
  k: T;
}

export interface Keyframe {
  t: number;
  s: Vec;
  i?: { x: number[]; y: number[] };
  o?: { x: number[]; y: number[] };
}

export interface Animated {
  a: 1;
  k: Keyframe[];
}

export type Prop<T = Vec> = Fixed<T> | Animated;

/**
 * A single number. The format is asymmetric here: a static scalar is a bare
 * number, while an animated one carries its value in a one element array.
 */
export type ScalarProp = Fixed<number> | Animated;

export interface Transform {
  o: ScalarProp;
  r: ScalarProp;
  p: Prop<Vec>;
  a: Prop<Vec>;
  s: Prop<Vec>;
}

export interface Mask {
  inv: boolean;
  mode: string;
  nm: string;
  pt: Fixed<unknown>;
  o: Fixed<number>;
  x: Fixed<number>;
}

export interface ShapeItem {
  ty: string;
  [key: string]: unknown;
}

export interface Layer {
  ddd: 0;
  ind: number;
  ty: number;
  nm: string;
  sr: number;
  ks: Transform;
  ao: 0;
  ip: number;
  op: number;
  st: number;
  bm: number;
  parent?: number;
  shapes?: ShapeItem[];
  refId?: string;
  w?: number;
  h?: number;
  hasMask?: boolean;
  masksProperties?: Mask[];
}

export interface PrecompAsset {
  id: string;
  layers: Layer[];
}

export interface ImageAsset {
  id: string;
  /** Embedded, so the file carries its own artwork. */
  p: string;
  u: '';
  e: 1;
  w: number;
  h: number;
}

export type Asset = PrecompAsset | ImageAsset;

export interface LottieDocument {
  v: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  nm: string;
  ddd: 0;
  assets: Asset[];
  layers: Layer[];
}

/* ------------------------------------------------------------- properties */

export function fixed<T>(value: T): Fixed<T> {
  return { a: 0, k: value };
}

/** Handles that make a cubic segment a straight line. */
const OUT = { x: [0], y: [0] };
const IN = { x: [1], y: [1] };

/**
 * An animated property from one sample per frame.
 *
 * Runs of the same value collapse to their first and last frame: a marble that
 * has finished, or machinery that is not turning, then costs two keyframes
 * instead of a thousand.
 */
export function animated(samples: Vec[], from = 0): Prop<Vec> {
  if (!samples.length) return fixed([0]);
  if (samples.length === 1) return fixed(samples[0]);

  const same = (a: Vec, b: Vec) => a.length === b.length && a.every((value, i) => value === b[i]);
  if (samples.every((sample) => same(sample, samples[0]))) return fixed(samples[0]);

  const keys: Keyframe[] = [];
  for (let i = 0; i < samples.length; i++) {
    const previous = samples[i - 1];
    const next = samples[i + 1];
    // Only the ends of a flat run are worth keeping.
    if (previous && next && same(previous, samples[i]) && same(next, samples[i])) continue;
    keys.push({ t: from + i, s: samples[i], i: IN, o: OUT });
  }

  // The last keyframe holds the final value, so it needs no outgoing handle.
  const last = keys[keys.length - 1];
  if (last) delete last.i;
  return { a: 1, k: keys };
}

export function scalar(samples: number[], from = 0): ScalarProp {
  if (!samples.length) return fixed(0);
  if (samples.every((value) => value === samples[0])) return fixed(samples[0]);
  return animated(samples.map((value) => [value]), from) as Animated;
}

/* ------------------------------------------------------------------ colour */

/** Lottie colours are 0..1, which is the single most common place to slip. */
export function colour(rgb: RGB): Vec {
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

/* ------------------------------------------------------------------ shapes */

export function ellipse(cx: number, cy: number, rx: number, ry = rx): ShapeItem {
  return { ty: 'el', p: fixed([cx, cy]), s: fixed([rx * 2, ry * 2]), d: 1 };
}

export function rect(cx: number, cy: number, w: number, h: number, radius = 0): ShapeItem {
  return { ty: 'rc', p: fixed([cx, cy]), s: fixed([w, h]), r: fixed(radius), d: 1 };
}

export function path(points: Array<[number, number]>, closed = true): ShapeItem {
  const zero = points.map(() => [0, 0]);
  return {
    ty: 'sh',
    ks: fixed({ i: zero, o: zero.map((p) => [...p]), v: points.map((p) => [p[0], p[1]]), c: closed }),
  };
}

export function fill(rgb: RGB, opacity = 100): ShapeItem {
  return { ty: 'fl', c: fixed(colour(rgb)), o: fixed(opacity), r: 1 };
}

export function stroke(rgb: RGB, width: number, opacity = 100): ShapeItem {
  return { ty: 'st', c: fixed(colour(rgb)), o: fixed(opacity), w: fixed(width), lc: 2, lj: 2 };
}

/** A two stop radial gradient, which is what gives a marble its roundness. */
export function radial(inner: RGB, outer: RGB, cx: number, cy: number, radius: number, opacity = 100): ShapeItem {
  return {
    ty: 'gf',
    t: 2,
    o: fixed(opacity),
    s: fixed([cx, cy]),
    e: fixed([cx + radius, cy]),
    g: { p: 2, k: fixed([0, ...colour(inner), 1, ...colour(outer)]) },
    r: 1,
  };
}

export function group(items: ShapeItem[], name = '', transform?: Partial<Transform>): ShapeItem {
  return {
    ty: 'gr',
    nm: name,
    it: [...items, { ty: 'tr', ...identity(), ...transform }],
  };
}

/**
 * A capsule: the rounded bar the board draws its rails, ramps and spinner arms
 * with. Built from a rectangle and two discs rather than hand rolled arcs —
 * the same silhouette, with nothing to get subtly wrong.
 */
export function capsule(ax: number, ay: number, bx: number, by: number, radius: number): ShapeItem[] {
  const length = Math.hypot(bx - ax, by - ay);
  const angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
  const midX = (ax + bx) / 2;
  const midY = (ay + by) / 2;

  const items: ShapeItem[] = [ellipse(-length / 2, 0, radius), ellipse(length / 2, 0, radius)];
  if (length > 0.01) items.unshift(rect(0, 0, length, radius * 2));

  return [
    {
      ty: 'gr',
      it: [
        ...items,
        { ty: 'tr', ...identity(), p: fixed([midX, midY]), r: fixed(angle) },
      ],
    },
  ];
}

export function identity(): Transform {
  return {
    o: fixed(100),
    r: fixed(0),
    p: fixed([0, 0]),
    a: fixed([0, 0]),
    s: fixed([100, 100]),
  };
}

/* ------------------------------------------------------------------ layers */

export interface LayerOptions {
  name: string;
  index: number;
  frames: number;
  transform?: Partial<Transform>;
  parent?: number;
  ip?: number;
}

function base(options: LayerOptions, type: number): Layer {
  return {
    ddd: 0,
    ind: options.index,
    ty: type,
    nm: options.name,
    sr: 1,
    ks: { ...identity(), ...options.transform },
    ao: 0,
    ip: options.ip ?? 0,
    op: options.frames,
    st: 0,
    bm: 0,
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
  };
}

export function shapeLayer(options: LayerOptions, shapes: ShapeItem[]): Layer {
  return { ...base(options, 4), shapes };
}

export function nullLayer(options: LayerOptions): Layer {
  return base(options, 3);
}

export function imageLayer(options: LayerOptions, refId: string): Layer {
  return { ...base(options, 2), refId };
}

export function precompLayer(options: LayerOptions, refId: string, w: number, h: number): Layer {
  return { ...base(options, 0), refId, w, h };
}
