/**
 * Procedural race course.
 *
 * The track is a tall vertical channel assembled from randomly drawn modules:
 * peg fields, spinners, pendulums, sliding bars, ramps, bumper pits and boost
 * pads. Everything is generated from the run seed, so a seed always rebuilds
 * exactly the same map.
 *
 * The modules lay down blueprint items rather than physics objects, so a
 * generated track and a hand drawn one are the same kind of thing: the map
 * editor can open either, and `compile()` is the single door into the solver.
 */

import { COURSE } from './board';
import { BLUEPRINT_VERSION, compile, newId, type Blueprint, type MapItem } from './blueprint';
import type { Booster, Course, Obstacle, Peg, Segment } from './types';
import type { Rng } from './rng';
import { mulberry32 } from './rng';

export { COURSE };

export const MAX_NAMES = 20;

export const TRACK_LENGTHS = {
  short: 9,
  standard: 16,
  epic: 26,
} as const;

export type TrackLength = keyof typeof TRACK_LENGTHS;

const PEG_R = 11;
const BUMPER_R = 21;

interface Build {
  rng: Rng;
  items: MapItem[];
}

type Module = (b: Build, y0: number) => number;

function peg(b: Build, x: number, y: number, bumper = false): void {
  b.items.push({ id: newId(), kind: 'peg', x, y, r: bumper ? BUMPER_R : PEG_R, bumper });
}

function wall(b: Build, x1: number, y1: number, x2: number, y2: number): void {
  b.items.push({ id: newId(), kind: 'wall', x1, y1, x2, y2 });
}

function spinner(
  b: Build,
  x: number,
  y: number,
  options: {
    arms: number;
    length: number;
    thickness: number;
    omega: number;
    hub?: number;
    hot?: boolean;
  },
): void {
  b.items.push({
    id: newId(),
    kind: 'spinner',
    x,
    y,
    arms: options.arms,
    length: options.length,
    thickness: options.thickness,
    hub: options.hub ?? 0,
    omega: options.omega,
    phase: b.rng() * Math.PI * 2,
    hot: options.hot ?? false,
  });
}

function pendulum(b: Build, x: number, y: number, length: number, omega: number, amp: number): void {
  b.items.push({ id: newId(), kind: 'pendulum', x, y, length, omega, amp, phase: b.rng() * Math.PI * 2 });
}

function slider(
  b: Build,
  x: number,
  y: number,
  halfLength: number,
  travel: number,
  omega: number,
  phase: number,
  tilt: number,
): void {
  // The bar is tilted: a flat bar would carry a resting marble along with it
  // for ever instead of letting it roll off the low end.
  b.items.push({ id: newId(), kind: 'slider', x, y, halfLength, travel, omega, phase, tilt });
}

function booster(b: Build, x: number, y: number, w: number, h: number, force: number): void {
  b.items.push({ id: newId(), kind: 'booster', x, y, w, h, force });
}

/* ---------------------------------------------------------------- modules */

const plinko: Module = (b, y0) => {
  // Wide spacing on purpose: a tight peg field turns into a trickle, and the
  // marbles need room to pick up speed between the rows.
  const rows = 4;
  const gap = 108;
  const hot = Math.floor(b.rng() * rows);

  for (let row = 0; row < rows; row++) {
    const even = row % 2 === 0;
    const cols = even ? 8 : 7;
    const startX = even ? 65 : 110;
    const y = y0 + 110 + row * gap;
    for (let col = 0; col < cols; col++) {
      const bumper = row === hot && (col === 2 || col === cols - 3);
      peg(b, startX + col * 90, y, bumper);
    }
  }
  return 110 + rows * gap + 40;
};

const spinners: Module = (b, y0) => {
  const dir = b.rng() < 0.5 ? 1 : -1;
  spinner(b, 236, y0 + 190, { arms: 4, length: 104, thickness: 15, omega: dir * (1.3 + b.rng() * 0.7), hub: 16 });
  spinner(b, 524, y0 + 360, { arms: 4, length: 104, thickness: 15, omega: -dir * (1.3 + b.rng() * 0.7), hub: 16 });

  peg(b, 380, y0 + 90, true);
  peg(b, 120, y0 + 420, false);
  peg(b, 640, y0 + 420, false);
  return 540;
};

const pinwheel: Module = (b, y0) => {
  const dir = b.rng() < 0.5 ? 1 : -1;
  spinner(b, 380, y0 + 300, {
    arms: 6,
    length: 176,
    thickness: 17,
    omega: dir * (0.85 + b.rng() * 0.5),
    hub: 26,
    hot: true,
  });
  peg(b, 110, y0 + 120, true);
  peg(b, 650, y0 + 120, true);
  peg(b, 110, y0 + 480, false);
  peg(b, 650, y0 + 480, false);
  return 600;
};

const zigzag: Module = (b, y0) => {
  // Ramps never overlap vertically, so they can not form a pocket that holds
  // a marble between two surfaces.
  const ramps = 3;
  const gap = 205;
  for (let i = 0; i < ramps; i++) {
    const y = y0 + 100 + i * gap;
    if (i % 2 === 0) {
      wall(b, COURSE.left, y, 505, y + 168);
      peg(b, 625, y + 130, i === 1);
    } else {
      wall(b, COURSE.right, y, 255, y + 168);
      peg(b, 135, y + 130, false);
    }
  }
  return 100 + ramps * gap + 90;
};

const pendulums: Module = (b, y0) => {
  const xs = [190, 380, 570];
  xs.forEach((x, i) => pendulum(b, x, y0 + 90, 190, 1.5 + b.rng() * 0.5, 0.85 + i * 0.06));
  peg(b, 110, y0 + 400, false);
  peg(b, 650, y0 + 400, false);
  peg(b, 300, y0 + 460, true);
  peg(b, 460, y0 + 460, true);
  return 560;
};

const sliders: Module = (b, y0) => {
  for (let i = 0; i < 3; i++) {
    slider(b, 380, y0 + 130 + i * 130, 130, 150, 1 + b.rng() * 0.6, i * 1.9, i % 2 === 0 ? 0.22 : -0.22);
  }
  peg(b, 130, y0 + 60, false);
  peg(b, 630, y0 + 60, false);
  return 520;
};

const bumperPit: Module = (b, y0) => {
  const spots: Array<[number, number]> = [
    [180, 130],
    [380, 210],
    [580, 130],
    [270, 340],
    [490, 340],
    [380, 450],
  ];
  for (const [x, dy] of spots) peg(b, x, y0 + dy, true);
  for (let i = 0; i < 5; i++) peg(b, 110 + i * 135, y0 + 40, false);
  return 540;
};

const gates: Module = (b, y0) => {
  // Two funnels feeding three lanes, with a spinner guarding the middle one.
  wall(b, COURSE.left, y0 + 70, 300, y0 + 210);
  wall(b, COURSE.right, y0 + 70, 460, y0 + 210);
  wall(b, 300, y0 + 210, 300, y0 + 300);
  wall(b, 460, y0 + 210, 460, y0 + 300);

  spinner(b, 380, y0 + 380, { arms: 3, length: 120, thickness: 16, omega: 1.6, hub: 18, hot: true });
  peg(b, 150, y0 + 330, false);
  peg(b, 610, y0 + 330, false);
  return 500;
};

const boostRun: Module = (b, y0) => {
  wall(b, COURSE.left, y0 + 40, 330, y0 + 150);
  booster(b, 350, y0 + 175, 200, 96, 2100);

  wall(b, COURSE.right, y0 + 330, 430, y0 + 440);
  booster(b, 210, y0 + 465, 200, 96, 2100);

  peg(b, 380, y0 + 640, true);
  peg(b, 200, y0 + 660, false);
  peg(b, 560, y0 + 660, false);
  return 720;
};

const MODULES: Array<{ name: string; build: Module }> = [
  { name: 'plinko', build: plinko },
  { name: 'spinners', build: spinners },
  { name: 'pinwheel', build: pinwheel },
  { name: 'zigzag', build: zigzag },
  { name: 'pendulums', build: pendulums },
  { name: 'sliders', build: sliders },
  { name: 'bumpers', build: bumperPit },
  { name: 'gates', build: gates },
  { name: 'boost', build: boostRun },
];

/* ----------------------------------------------------------------- course */

export function marbleRadius(count: number): number {
  const slot = (COURSE.right - COURSE.left) / Math.max(count, 1);
  return Math.max(12, Math.min(17, slot * 0.44));
}

/**
 * Lays out a track as an editable blueprint. Same seed, same map, every time.
 */
export function generateBlueprint(seed: number, moduleCount: number, label = ''): Blueprint {
  const rng = mulberry32(seed ^ 0x2f6b1d3);
  const b: Build = { rng, items: [] };

  // Start chute: a short drop that spreads the field before the first module.
  let y = 300;
  for (let i = 0; i < 7; i++) peg(b, 110 + i * 90, y - 40, false);

  const kinds: number[] = [];
  let previous = -1;
  for (let i = 0; i < moduleCount; i++) {
    let pick = Math.floor(rng() * MODULES.length);
    if (pick === previous) pick = (pick + 1 + Math.floor(rng() * (MODULES.length - 1))) % MODULES.length;
    previous = pick;
    kinds.push(pick);
  }
  // Always open with a plinko spread so the field fans out fairly.
  kinds[0] = 0;

  const marks: Blueprint['marks'] = [];
  for (const kind of kinds) {
    const height = MODULES[kind].build(b, y);
    marks.push({ y, name: MODULES[kind].name });
    y += height;
  }

  // Finish: a wide funnel into the finish line.
  const funnelTop = y + 40;
  const finishY = funnelTop + 300;
  wall(b, COURSE.left, funnelTop, 300, funnelTop + 190);
  wall(b, COURSE.right, funnelTop, 460, funnelTop + 190);
  wall(b, 300, funnelTop + 190, 300, finishY + 60);
  wall(b, 460, funnelTop + 190, 460, finishY + 60);

  return { version: BLUEPRINT_VERSION, name: label, seed: label || null, finishY, items: b.items, marks };
}

export function createCourse(seed: number, moduleCount: number): Course {
  return compile(generateBlueprint(seed, moduleCount));
}

/** Advances every moving obstacle to the given course time. */
export function driveObstacles(course: Course, time: number): void {
  for (const o of course.obstacles) {
    switch (o.motion) {
      case 'spin':
        o.angle = o.phase + o.omega * time;
        o.spin = o.omega;
        break;
      case 'swing': {
        const w = o.omega;
        o.angle = o.amp * Math.sin(w * time + o.phase);
        o.spin = o.amp * w * Math.cos(w * time + o.phase);
        break;
      }
      case 'slide': {
        const w = o.omega;
        o.ox = o.amp * Math.sin(w * time + o.phase);
        o.vx = o.amp * w * Math.cos(w * time + o.phase);
        break;
      }
    }
  }
}

/** Buckets course content by height so collision lookups stay local. */
export function indexCourse(course: Course, bucketSize: number) {
  const count = Math.ceil(course.height / bucketSize) + 2;
  const pegs: Peg[][] = Array.from({ length: count }, () => []);
  const walls: Segment[][] = Array.from({ length: count }, () => []);
  const obstacles: Obstacle[][] = Array.from({ length: count }, () => []);
  const boosters: Booster[][] = Array.from({ length: count }, () => []);

  const put = <T>(list: T[][], from: number, to: number, item: T) => {
    const a = Math.max(0, Math.floor(from / bucketSize));
    const bIdx = Math.min(count - 1, Math.floor(to / bucketSize));
    for (let i = a; i <= bIdx; i++) list[i].push(item);
  };

  for (const p of course.pegs) put(pegs, p.y - p.r, p.y + p.r, p);
  for (const w of course.walls) put(walls, Math.min(w.y1, w.y2), Math.max(w.y1, w.y2), w);
  for (const o of course.obstacles) put(obstacles, o.pivotY - o.reach, o.pivotY + o.reach, o);
  for (const s of course.boosters) put(boosters, s.y, s.y + s.h, s);

  return { bucketSize, count, pegs, walls, obstacles, boosters };
}

export type CourseIndex = ReturnType<typeof indexCourse>;
