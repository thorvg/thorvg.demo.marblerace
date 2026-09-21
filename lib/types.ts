/** Shared value types for the race. */

import type { Skin } from './skins';

export type RGB = readonly [number, number, number];

export interface Vec2 {
  x: number;
  y: number;
}

/** A static circular obstacle. Bumpers are pegs with a punchier response. */
export interface Peg {
  x: number;
  y: number;
  r: number;
  bumper: boolean;
  /** 0..1 decaying flash energy, driven by collisions and consumed by the renderer. */
  energy: number;
}

/** A static line obstacle. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Obstacle geometry, expressed in the obstacle's own pivot space. */
export type ObstaclePart =
  | { kind: 'capsule'; ax: number; ay: number; bx: number; by: number; r: number }
  | { kind: 'circle'; cx: number; cy: number; r: number };

/** A moving obstacle: spinning arms, a swinging pendulum or a sliding bar. */
export interface Obstacle {
  parts: ObstaclePart[];
  pivotX: number;
  pivotY: number;
  motion: 'spin' | 'swing' | 'slide';
  /** Angular speed for spin/swing, oscillation speed for slide. */
  omega: number;
  /** Swing amplitude in radians, or slide travel in world units. */
  amp: number;
  phase: number;
  restitution: number;
  hot: boolean;
  /** Farthest extent from the pivot, used for bucketing and culling. */
  reach: number;

  // Driven every step by driveObstacles().
  angle: number;
  ox: number;
  oy: number;
  /** Current angular velocity. */
  spin: number;
  vx: number;
  vy: number;
}

/** A pad that accelerates marbles downwards while they are inside it. */
export interface Booster {
  x: number;
  y: number;
  w: number;
  h: number;
  force: number;
}

/**
 * A piece of artwork laid on the board. Scenery only: the solver never sees
 * these, and the renderer draws them behind everything else.
 */
export interface Decal {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..100. */
  opacity: number;
  art: Skin;
}

export interface Course {
  height: number;
  pegs: Peg[];
  walls: Segment[];
  obstacles: Obstacle[];
  boosters: Booster[];
  /** Artwork laid behind the track. Ignored by the physics. */
  decals: Decal[];
  /** Module start heights, used by the mini map. */
  marks: Array<{ y: number; name: string }>;
  finishY: number;
  goal: Vec2;
  goalRadius: number;
}

export interface Marble {
  index: number;
  name: string;
  color: RGB;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Ring buffer of previous positions, newest last. Used for the motion trail. */
  trail: number[];
  /** Deepest point reached, which is what the standings are ranked on. */
  best: number;
  /** Live standing, 0 = leading. */
  rank: number;
  finished: boolean;
  finishTime: number;
  /** Seconds since this marble last took a boost pad. */
  boost: number;
  /** Per marble rescue pull, ramps up when it stops making progress. */
  assist: number;
  stall: number;
  spin: number;
}

export type Phase = 'idle' | 'preview' | 'countdown' | 'racing' | 'reveal';

/**
 * What a run is for. `winner` stops at the first marble across the line;
 * `ranking` keeps going until the whole field is in.
 */
export type RaceMode = 'winner' | 'ranking';

/** One runner's final placing. */
export interface RankEntry {
  place: number;
  index: number;
  name: string;
  color: RGB;
  /** Seconds from the drop, or null for a marble that never made it in. */
  elapsed: number | null;
}
