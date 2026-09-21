/**
 * Map blueprint: the editable description of a course.
 *
 * A blueprint is plain JSON, a flat list of placed items plus the finish line.
 * The procedural generator emits one, the map editor mutates one, and
 * `compile()` turns one into the `Course` the physics and the renderer eat.
 *
 * Everything on the way in is clamped: an item that arrives from an imported
 * file, or from a drag that ran off the board, is pulled back into range rather
 * than handed to the simulation. A blueprint can therefore be nonsense as a
 * race, but it can never be geometry the solver cannot cope with.
 */

import { COURSE } from './board';
import { skinKey, type Skin, type SkinType } from './skins';
import type { Booster, Course, Decal, Obstacle, ObstaclePart, Peg, RGB, Segment } from './types';

export const BLUEPRINT_VERSION = 1;

/** Course length below the finish line, so runners have somewhere to land. */
const FINISH_TAIL = 260;

export const FINISH_MIN = COURSE.releaseY + 700;
/** Comfortably past the longest generated track, and still sliderable. */
export const FINISH_MAX = 24_000;

/** Widest a dropped piece of artwork is sized to on arrival. */
const DECAL_FIT = 420;

/** Visual half width of a wall, also what the picker treats as its thickness. */
export const WALL_R = 8;

/** Pieces the palette can place by hand. */
export type ToolKind = 'peg' | 'wall' | 'spinner' | 'pendulum' | 'slider' | 'booster';

/** Everything a map can hold. `decal` only ever arrives by dropping a file. */
export type ItemKind = ToolKind | 'decal';

export const TOOL_KINDS: readonly ToolKind[] = ['peg', 'wall', 'spinner', 'pendulum', 'slider', 'booster'];

export const ITEM_KINDS: readonly ItemKind[] = [...TOOL_KINDS, 'decal'];

export interface PegItem {
  id: string;
  kind: 'peg';
  x: number;
  y: number;
  r: number;
  /** Bumpers are pegs with a punchier response and their own colour. */
  bumper: boolean;
}

export interface WallItem {
  id: string;
  kind: 'wall';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SpinnerItem {
  id: string;
  kind: 'spinner';
  x: number;
  y: number;
  arms: number;
  length: number;
  thickness: number;
  hub: number;
  /** Revolutions are signed: a negative speed turns the other way. */
  omega: number;
  phase: number;
  hot: boolean;
}

export interface PendulumItem {
  id: string;
  kind: 'pendulum';
  x: number;
  y: number;
  length: number;
  omega: number;
  /** Swing amplitude in radians. */
  amp: number;
  phase: number;
}

export interface SliderItem {
  id: string;
  kind: 'slider';
  x: number;
  y: number;
  halfLength: number;
  /** Sideways travel in world units. */
  travel: number;
  omega: number;
  phase: number;
  /** Bar tilt, so a resting marble rolls off the low end. */
  tilt: number;
}

export interface BoosterItem {
  id: string;
  kind: 'booster';
  x: number;
  y: number;
  w: number;
  h: number;
  force: number;
}

/**
 * A piece of artwork laid on the board: an image, an SVG or a Lottie. Decals
 * are scenery, not obstacles — nothing collides with them, and they are drawn
 * behind the whole track so the course always stays readable on top.
 */
export interface DecalItem {
  id: string;
  kind: 'decal';
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..100, so the inspector can dial artwork back to a watermark. */
  opacity: number;
  art: Skin;
}

export type MapItem = PegItem | WallItem | SpinnerItem | PendulumItem | SliderItem | BoosterItem | DecalItem;

/** Items that move, which share the pivot handling in the compiler. */
export type MovingItem = SpinnerItem | PendulumItem | SliderItem;

export interface Blueprint {
  version: number;
  name: string;
  /** Set when the map came out of the generator untouched. */
  seed: string | null;
  finishY: number;
  items: MapItem[];
  /** Section markers the mini map draws. Generated maps carry them. */
  marks: Array<{ y: number; name: string }>;
}

/* ------------------------------------------------------------------ limits */

export interface FieldSpec {
  key: string;
  min: number;
  max: number;
  step: number;
}

/** Numeric fields the inspector edits, per kind. Positions are dragged, not typed. */
export const FIELDS: Record<ItemKind, readonly FieldSpec[]> = {
  peg: [{ key: 'r', min: 5, max: 48, step: 1 }],
  wall: [],
  spinner: [
    { key: 'arms', min: 1, max: 8, step: 1 },
    { key: 'length', min: 24, max: 320, step: 1 },
    { key: 'thickness', min: 5, max: 44, step: 1 },
    { key: 'hub', min: 0, max: 64, step: 1 },
    { key: 'omega', min: -4, max: 4, step: 0.05 },
    { key: 'phase', min: 0, max: 6.283, step: 0.05 },
  ],
  pendulum: [
    { key: 'length', min: 50, max: 460, step: 1 },
    { key: 'amp', min: 0, max: 1.6, step: 0.02 },
    { key: 'omega', min: 0.1, max: 4, step: 0.05 },
    { key: 'phase', min: 0, max: 6.283, step: 0.05 },
  ],
  slider: [
    { key: 'halfLength', min: 30, max: 280, step: 1 },
    { key: 'travel', min: 0, max: 320, step: 1 },
    { key: 'omega', min: 0.1, max: 4, step: 0.05 },
    { key: 'tilt', min: -0.6, max: 0.6, step: 0.02 },
    { key: 'phase', min: 0, max: 6.283, step: 0.05 },
  ],
  booster: [
    { key: 'w', min: 40, max: 640, step: 2 },
    { key: 'h', min: 30, max: 420, step: 2 },
    { key: 'force', min: 200, max: 4200, step: 50 },
  ],
  decal: [
    { key: 'w', min: 20, max: 1400, step: 2 },
    { key: 'h', min: 20, max: 4000, step: 2 },
    { key: 'opacity', min: 5, max: 100, step: 1 },
  ],
};

/** Toggles the inspector shows next to the numeric fields. */
export const FLAGS: Partial<Record<ItemKind, readonly string[]>> = {
  peg: ['bumper'],
  spinner: ['hot'],
};

function spec(kind: ItemKind, key: string): FieldSpec | undefined {
  return FIELDS[kind].find((field) => field.key === key);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamps every field of an item into range, in place. Idempotent. */
export function clampItem(item: MapItem): MapItem {
  const inX = (v: number) => clamp(num(v, COURSE.width / 2), COURSE.left, COURSE.right);
  const inY = (v: number) => clamp(num(v, 0), -400, FINISH_MAX + FINISH_TAIL);

  if (item.kind === 'decal') {
    // Artwork is scenery: it is allowed to bleed past the rails, so it is only
    // held inside a generous margin rather than the play field itself.
    item.x = clamp(num(item.x, 0), -900, COURSE.width + 900);
    item.y = inY(item.y);
  } else if (item.kind !== 'wall') {
    item.x = inX(item.x);
    item.y = inY(item.y);
  }

  switch (item.kind) {
    case 'peg':
      item.r = clamp(num(item.r, 11), 5, 48);
      item.bumper = item.bumper === true;
      break;
    case 'wall':
      item.x1 = inX(item.x1);
      item.x2 = inX(item.x2);
      item.y1 = inY(item.y1);
      item.y2 = inY(item.y2);
      break;
    default:
      for (const field of FIELDS[item.kind]) {
        const record = item as unknown as Record<string, number>;
        record[field.key] = clamp(num(record[field.key], field.min), field.min, field.max);
      }
      if (item.kind === 'spinner') {
        item.arms = Math.round(item.arms);
        item.hot = item.hot === true;
      }
      break;
  }
  return item;
}

/** Applies one inspector field, clamped to its spec. */
export function setField(item: MapItem, key: string, value: number): void {
  const field = spec(item.kind, key);
  if (!field) return;
  const record = item as unknown as Record<string, number>;
  record[key] = clamp(num(value, field.min), field.min, field.max);
  if (item.kind === 'spinner' && key === 'arms') item.arms = Math.round(item.arms);
}

/* -------------------------------------------------------------------- ids */

let counter = 0;

export function newId(): string {
  counter = (counter + 1) % 1e6;
  return `i${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function cloneItem<T extends MapItem>(item: T): T {
  return { ...item };
}

/** Artwork carried by a map, in draw order. */
export function decalsOf(items: readonly MapItem[]): DecalItem[] {
  return items.filter((item): item is DecalItem => item.kind === 'decal');
}

export function cloneItems(items: readonly MapItem[]): MapItem[] {
  return items.map((item) => ({ ...item }));
}

export function emptyBlueprint(): Blueprint {
  return { version: BLUEPRINT_VERSION, name: '', seed: null, finishY: 2400, items: [], marks: [] };
}

/* ------------------------------------------------------------- new items */

/** A freshly placed piece of `kind`, centred on the given point. */
export function createItem(kind: ToolKind, x: number, y: number): MapItem {
  const id = newId();
  switch (kind) {
    case 'peg':
      return clampItem({ id, kind: 'peg', x, y, r: 11, bumper: false });
    case 'wall':
      return clampItem({ id, kind: 'wall', x1: x - 90, y1: y - 40, x2: x + 90, y2: y + 40 });
    case 'spinner':
      return clampItem({
        id,
        kind: 'spinner',
        x,
        y,
        arms: 4,
        length: 104,
        thickness: 15,
        hub: 16,
        omega: 1.5,
        phase: 0,
        hot: false,
      });
    case 'pendulum':
      return clampItem({ id, kind: 'pendulum', x, y, length: 190, omega: 1.7, amp: 0.9, phase: 0 });
    case 'slider':
      return clampItem({ id, kind: 'slider', x, y, halfLength: 130, travel: 150, omega: 1.3, phase: 0, tilt: 0.22 });
    case 'booster':
      return clampItem({ id, kind: 'booster', x: x - 100, y: y - 48, w: 200, h: 96, force: 2100 });
  }
}

/**
 * Wraps dropped artwork as a decal, sized to fit the board while keeping its
 * own proportions, and centred on the drop point.
 */
export function createDecal(art: Skin, x: number, y: number, width: number, height: number): DecalItem {
  const fit = Math.min(1, DECAL_FIT / Math.max(width, 1), (DECAL_FIT * 1.6) / Math.max(height, 1));
  const w = Math.max(20, Math.round(width * fit));
  const h = Math.max(20, Math.round(height * fit));
  return clampItem({
    id: newId(),
    kind: 'decal',
    x: x - w / 2,
    y: y - h / 2,
    w,
    h,
    opacity: 100,
    art,
  }) as DecalItem;
}

/* --------------------------------------------------------------- geometry */

/** Obstacle pose at course time zero, which is what the editor draws and picks. */
export function restPose(item: MovingItem): { angle: number; ox: number } {
  switch (item.kind) {
    case 'spinner':
      return { angle: item.phase, ox: 0 };
    case 'pendulum':
      return { angle: item.amp * Math.sin(item.phase), ox: 0 };
    case 'slider':
      return { angle: 0, ox: item.travel * Math.sin(item.phase) };
  }
}

/** Obstacle geometry in pivot space. Shared by the compiler and the editor. */
export function partsOf(item: MovingItem): ObstaclePart[] {
  switch (item.kind) {
    case 'spinner': {
      const parts: ObstaclePart[] = [];
      for (let i = 0; i < item.arms; i++) {
        const a = (i / item.arms) * Math.PI * 2;
        parts.push({
          kind: 'capsule',
          ax: 0,
          ay: 0,
          bx: Math.cos(a) * item.length,
          by: Math.sin(a) * item.length,
          r: item.thickness / 2,
        });
      }
      if (item.hub > 0) parts.push({ kind: 'circle', cx: 0, cy: 0, r: item.hub });
      return parts;
    }
    case 'pendulum':
      return [
        { kind: 'capsule', ax: 0, ay: 18, bx: 0, by: item.length, r: 9 },
        { kind: 'circle', cx: 0, cy: item.length, r: 20 },
      ];
    case 'slider':
      return [
        {
          kind: 'capsule',
          ax: -item.halfLength,
          ay: -item.halfLength * item.tilt,
          bx: item.halfLength,
          by: item.halfLength * item.tilt,
          r: 9,
        },
      ];
  }
}

/** Farthest extent from the pivot, used for bucketing, culling and picking. */
export function reachOf(item: MovingItem): number {
  switch (item.kind) {
    case 'spinner':
      return item.length + item.thickness;
    case 'pendulum':
      return item.length + 26;
    case 'slider':
      return item.halfLength + item.travel + 20;
  }
}

export function isMoving(item: MapItem): item is MovingItem {
  return item.kind === 'spinner' || item.kind === 'pendulum' || item.kind === 'slider';
}

/**
 * Whether a moving part carries the hot colour and the punchier bounce. Read by
 * the compiler and by the editor's own drawing, so the two cannot drift apart.
 */
export function isHot(item: MovingItem): boolean {
  return item.kind === 'spinner' ? item.hot : item.kind === 'pendulum';
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Axis aligned bounds, used for culling and rubber band selection. */
export function boundsOf(item: MapItem): Box {
  switch (item.kind) {
    case 'peg':
      return { x0: item.x - item.r, y0: item.y - item.r, x1: item.x + item.r, y1: item.y + item.r };
    case 'wall':
      return {
        x0: Math.min(item.x1, item.x2) - WALL_R,
        y0: Math.min(item.y1, item.y2) - WALL_R,
        x1: Math.max(item.x1, item.x2) + WALL_R,
        y1: Math.max(item.y1, item.y2) + WALL_R,
      };
    case 'booster':
    case 'decal':
      return { x0: item.x, y0: item.y, x1: item.x + item.w, y1: item.y + item.h };
    default: {
      const reach = reachOf(item);
      return { x0: item.x - reach, y0: item.y - reach, x1: item.x + reach, y1: item.y + reach };
    }
  }
}

/** Where an item sits, for nudging and for the multi select drag. */
export function moveItem(item: MapItem, dx: number, dy: number): void {
  if (item.kind === 'wall') {
    item.x1 += dx;
    item.y1 += dy;
    item.x2 += dx;
    item.y2 += dy;
  } else {
    item.x += dx;
    item.y += dy;
  }
  clampItem(item);
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Signed distance from a point to an item's drawn surface: negative inside,
 * positive outside. The editor picks the item with the smallest value.
 */
export function distanceToItem(item: MapItem, px: number, py: number): number {
  switch (item.kind) {
    case 'peg':
      return Math.hypot(px - item.x, py - item.y) - item.r;
    case 'wall':
      return distanceToSegment(px, py, item.x1, item.y1, item.x2, item.y2) - WALL_R;
    case 'decal':
    case 'booster': {
      const dx = Math.max(item.x - px, 0, px - (item.x + item.w));
      const dy = Math.max(item.y - py, 0, py - (item.y + item.h));
      if (dx === 0 && dy === 0) {
        return -Math.min(px - item.x, item.x + item.w - px, py - item.y, item.y + item.h - py);
      }
      return Math.hypot(dx, dy);
    }
    default: {
      const { angle, ox } = restPose(item);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = item.x + ox;
      const cy = item.y;
      let best = Infinity;

      for (const part of partsOf(item)) {
        if (part.kind === 'circle') {
          const x = cx + part.cx * cos - part.cy * sin;
          const y = cy + part.cx * sin + part.cy * cos;
          best = Math.min(best, Math.hypot(px - x, py - y) - part.r);
          continue;
        }
        const ax = cx + part.ax * cos - part.ay * sin;
        const ay = cy + part.ax * sin + part.ay * cos;
        const bx = cx + part.bx * cos - part.by * sin;
        const by = cy + part.bx * sin + part.by * cos;
        best = Math.min(best, distanceToSegment(px, py, ax, ay, bx, by) - part.r);
      }
      return best;
    }
  }
}

/* --------------------------------------------------------------- handles */

/** A drag point on a selected item. `id` is unique within the item. */
export interface Handle {
  id: string;
  x: number;
  y: number;
  /** Mouse cursor to show while it is under the pointer. */
  cursor: string;
}

export function handlesOf(item: MapItem): Handle[] {
  switch (item.kind) {
    case 'peg':
      return [{ id: 'r', x: item.x + item.r, y: item.y, cursor: 'ew-resize' }];
    case 'wall':
      return [
        { id: 'a', x: item.x1, y: item.y1, cursor: 'move' },
        { id: 'b', x: item.x2, y: item.y2, cursor: 'move' },
      ];
    case 'decal':
    case 'booster':
      return [
        { id: 'nw', x: item.x, y: item.y, cursor: 'nwse-resize' },
        { id: 'ne', x: item.x + item.w, y: item.y, cursor: 'nesw-resize' },
        { id: 'se', x: item.x + item.w, y: item.y + item.h, cursor: 'nwse-resize' },
        { id: 'sw', x: item.x, y: item.y + item.h, cursor: 'nesw-resize' },
      ];
    case 'spinner': {
      const a = item.phase;
      return [{ id: 'arm', x: item.x + Math.cos(a) * item.length, y: item.y + Math.sin(a) * item.length, cursor: 'grab' }];
    }
    case 'pendulum': {
      const angle = item.amp * Math.sin(item.phase);
      return [
        {
          id: 'bob',
          x: item.x - Math.sin(angle) * item.length,
          y: item.y + Math.cos(angle) * item.length,
          cursor: 'ns-resize',
        },
      ];
    }
    case 'slider': {
      const ox = item.travel * Math.sin(item.phase);
      return [
        { id: 'bar', x: item.x + ox + item.halfLength, y: item.y + item.halfLength * item.tilt, cursor: 'ew-resize' },
        { id: 'travel', x: item.x + item.travel, y: item.y - 34, cursor: 'ew-resize' },
      ];
    }
  }
}

/**
 * Drags one handle to a world point. Handles carry the whole resize vocabulary,
 * so the editor never needs to know what a spinner arm or a booster corner is.
 */
export function dragHandle(item: MapItem, handle: string, wx: number, wy: number): void {
  switch (item.kind) {
    case 'peg':
      item.r = Math.hypot(wx - item.x, wy - item.y);
      break;
    case 'wall':
      if (handle === 'a') {
        item.x1 = wx;
        item.y1 = wy;
      } else {
        item.x2 = wx;
        item.y2 = wy;
      }
      break;
    case 'decal':
    case 'booster': {
      const right = item.x + item.w;
      const bottom = item.y + item.h;
      const x0 = handle === 'nw' || handle === 'sw' ? wx : item.x;
      const y0 = handle === 'nw' || handle === 'ne' ? wy : item.y;
      const x1 = handle === 'ne' || handle === 'se' ? wx : right;
      const y1 = handle === 'se' || handle === 'sw' ? wy : bottom;
      item.x = Math.min(x0, x1);
      item.y = Math.min(y0, y1);
      item.w = Math.abs(x1 - x0);
      item.h = Math.abs(y1 - y0);
      break;
    }
    case 'spinner': {
      // One handle does both jobs: the distance sets the arm length and the
      // bearing sets the phase, so a spinner is rotated by dragging a tip.
      const dx = wx - item.x;
      const dy = wy - item.y;
      item.length = Math.hypot(dx, dy);
      item.phase = Math.atan2(dy, dx);
      if (item.phase < 0) item.phase += Math.PI * 2;
      break;
    }
    case 'pendulum':
      item.length = Math.hypot(wx - item.x, wy - item.y);
      break;
    case 'slider':
      if (handle === 'bar') {
        item.halfLength = Math.abs(wx - item.x - item.travel * Math.sin(item.phase));
      } else {
        item.travel = Math.abs(wx - item.x);
      }
      break;
  }
  clampItem(item);
}

/* -------------------------------------------------------------- compiler */

export function courseHeight(finishY: number): number {
  return clamp(finishY, FINISH_MIN, FINISH_MAX) + FINISH_TAIL;
}

/**
 * Turns a blueprint into the course the physics runs on. This is the only door
 * between an edited map and the simulation, so it clamps as it goes.
 */
export function compile(blueprint: Blueprint): Course {
  const pegs: Peg[] = [];
  const walls: Segment[] = [];
  const obstacles: Obstacle[] = [];
  const boosters: Booster[] = [];
  const decals: Decal[] = [];

  const finishY = clamp(num(blueprint.finishY, 2400), FINISH_MIN, FINISH_MAX);

  for (const item of blueprint.items) {
    clampItem(item);
    switch (item.kind) {
      case 'peg':
        pegs.push({ x: item.x, y: item.y, r: item.r, bumper: item.bumper, energy: 0 });
        break;
      case 'wall':
        walls.push({ x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 });
        break;
      case 'booster':
        boosters.push({ x: item.x, y: item.y, w: item.w, h: item.h, force: item.force });
        break;
      case 'decal':
        decals.push({ x: item.x, y: item.y, w: item.w, h: item.h, opacity: item.opacity, art: item.art });
        break;
      default:
        obstacles.push({
          parts: partsOf(item),
          pivotX: item.x,
          pivotY: item.y,
          motion: item.kind === 'spinner' ? 'spin' : item.kind === 'pendulum' ? 'swing' : 'slide',
          omega: item.omega,
          amp: item.kind === 'pendulum' ? item.amp : item.kind === 'slider' ? item.travel : 0,
          phase: item.phase,
          // Hot machinery is the showy kind, so it throws a marble harder.
          restitution: item.kind === 'pendulum' ? 0.62 : item.kind === 'slider' ? 0.5 : item.hot ? 0.6 : 0.55,
          hot: isHot(item),
          reach: reachOf(item),
          angle: 0,
          ox: 0,
          oy: 0,
          spin: 0,
          vx: 0,
          vy: 0,
        });
        break;
    }
  }

  return {
    height: finishY + FINISH_TAIL,
    pegs,
    walls,
    obstacles,
    boosters,
    decals,
    marks: blueprint.marks.filter((mark) => mark.y < finishY),
    finishY,
    goal: { x: COURSE.width / 2, y: finishY + 96 },
    goalRadius: 58,
  };
}

/* ------------------------------------------------------------ serialising */

export function blueprintToJson(blueprint: Blueprint): string {
  return JSON.stringify({ ...blueprint, version: BLUEPRINT_VERSION }, null, 2);
}

const SKIN_TYPES: readonly SkinType[] = ['png', 'jpg', 'webp', 'svg', 'lot'];

/** Artwork off a map file. Anything without usable bytes is dropped. */
function readArt(value: unknown): Skin | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Skin>;
  if (typeof raw.uri !== 'string' || !raw.uri.startsWith('data:')) return null;
  if (!raw.type || !SKIN_TYPES.includes(raw.type)) return null;
  const kind = raw.type === 'lot' ? 'lottie' : raw.type === 'svg' ? 'svg' : 'image';
  return { kind, type: raw.type, label: typeof raw.label === 'string' ? raw.label.slice(0, 80) : 'artwork', uri: raw.uri };
}

function readItem(value: unknown): MapItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !ITEM_KINDS.includes(kind as ItemKind)) return null;

  if (kind === 'decal') {
    const art = readArt(raw.art);
    // A decal is nothing without its artwork, so a stripped one is dropped.
    if (!art) return null;
    const decal = createDecal(art, 0, 0, num(raw.w, 300), num(raw.h, 300));
    decal.x = num(raw.x, 0);
    decal.y = num(raw.y, 400);
    decal.w = num(raw.w, decal.w);
    decal.h = num(raw.h, decal.h);
    decal.opacity = num(raw.opacity, 100);
    if (typeof raw.id === 'string' && raw.id.length <= 64) decal.id = raw.id;
    return clampItem(decal);
  }

  // Built from a fresh default, so a file missing a field still lands in range.
  const base = createItem(kind as ToolKind, num(raw.x, COURSE.width / 2), num(raw.y, 400));
  const target = base as unknown as Record<string, unknown>;
  for (const [key, entry] of Object.entries(raw)) {
    if (key === 'id' || key === 'kind') continue;
    if (typeof entry === 'number' || typeof entry === 'boolean') target[key] = entry;
  }
  if (typeof raw.id === 'string' && raw.id.length <= 64) base.id = raw.id;
  return clampItem(base);
}

/** Tolerant parser: anything unrecognised is dropped rather than failing. */
export function parseBlueprint(text: string): Blueprint | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.items)) return null;

  const blueprint = emptyBlueprint();
  if (typeof source.name === 'string') blueprint.name = source.name.slice(0, 60);
  if (typeof source.seed === 'string') blueprint.seed = source.seed.slice(0, 10);
  blueprint.finishY = clamp(num(source.finishY, 2400), FINISH_MIN, FINISH_MAX);

  const seen = new Set<string>();
  for (const entry of source.items.slice(0, 4000)) {
    const item = readItem(entry);
    if (!item) continue;
    // Duplicate ids would make selection and undo point at the wrong item.
    if (seen.has(item.id)) item.id = newId();
    seen.add(item.id);
    blueprint.items.push(item);
  }

  if (Array.isArray(source.marks)) {
    for (const entry of source.marks.slice(0, 200)) {
      if (!entry || typeof entry !== 'object') continue;
      const mark = entry as Record<string, unknown>;
      if (typeof mark.name !== 'string') continue;
      blueprint.marks.push({ y: num(mark.y, 0), name: mark.name.slice(0, 24) });
    }
  }

  return blueprint;
}

/**
 * Compact identity for a map, used to tell whether anything actually changed.
 *
 * Artwork is folded down to a fingerprint rather than compared byte for byte:
 * a blueprint carrying a few megabytes of images would otherwise be serialised
 * in full every time React re-ran an effect.
 */
export function blueprintSignature(blueprint: Blueprint): string {
  const parts: string[] = [`f${Math.round(blueprint.finishY)}`];
  for (const item of blueprint.items) {
    if (item.kind === 'decal') {
      parts.push(`d:${item.x}:${item.y}:${item.w}:${item.h}:${item.opacity}:${skinKey(item.art)}`);
      continue;
    }
    const record = item as unknown as Record<string, unknown>;
    let part = item.kind;
    for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'r', 'bumper', 'hot', ...FIELDS[item.kind].map((f) => f.key)]) {
      const value = record[key];
      if (value !== undefined) part += `:${typeof value === 'number' ? Math.round(value * 100) / 100 : value}`;
    }
    parts.push(part);
  }
  return parts.join('|');
}

export function cloneBlueprint(blueprint: Blueprint): Blueprint {
  return {
    ...blueprint,
    items: cloneItems(blueprint.items),
    marks: blueprint.marks.map((mark) => ({ ...mark })),
  };
}
