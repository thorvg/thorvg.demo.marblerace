/**
 * Marble physics.
 *
 * Fixed timestep, seeded PRNG: the same seed and roster always produce the same
 * race. Marbles collide with pegs, static walls, the side rails and the moving
 * obstacles, and each other. Moving obstacles hand their surface velocity to
 * the marble, which is what makes a spinner fling the leader across the track.
 *
 * Robustness first: contacts always push the marble back outside the obstacle,
 * the per step displacement stays far below the marble radius so nothing
 * tunnels, and a marble that stops making progress gets a growing pull towards
 * the finish, so a race always ends.
 */

import { COURSE, driveObstacles, indexCourse, marbleRadius, type CourseIndex } from './course';
import { marbleColor } from './palette';
import { mulberry32, shuffle, type Rng } from './rng';
import type { Booster, Course, Marble, Obstacle, ObstaclePart, Peg, RGB, Segment } from './types';

export const FIXED_DT = 1 / 240;

const GRAVITY = 1600;
const MAX_SPEED = 1100;
const DRAG = 0.06;
const PEG_RESTITUTION = 0.44;
const BUMPER_RESTITUTION = 0.86;
const BUMPER_KICK = 210;
const WALL_RESTITUTION = 0.35;
const TANGENT_KEEP = 0.97;
const MARBLE_RESTITUTION = 0.32;
const TRAIL_LENGTH = 18;
const BUCKET = 120;

export interface Impact {
  x: number;
  y: number;
  nx: number;
  ny: number;
  strength: number;
  bumper: boolean;
  color: RGB;
}

export class Simulation {
  readonly course: Course;
  readonly marbles: Marble[];
  readonly impacts: Impact[] = [];
  /** Marbles in the order they crossed the finish line. */
  readonly finishOrder: Marble[] = [];
  /** Marble indices ordered by standing, leader first. */
  readonly standings: Marble[] = [];

  time = 0;
  winner: Marble | null = null;
  winTime = 0;
  /** Count of marbles across the line, so a ranking run knows when it is done. */
  finishedCount = 0;
  /** Gap in world units between the leader and the runner up. */
  gap = 0;

  #rng: Rng;
  #index: CourseIndex;

  constructor(course: Course, names: readonly string[], seed: number) {
    this.course = course;
    this.#rng = mulberry32(seed);
    this.#index = indexCourse(course, BUCKET);

    const count = names.length;
    const radius = marbleRadius(count);
    const slotWidth = (COURSE.right - COURSE.left) / Math.max(count, 1);
    // Names are dealt to release slots at random, so list order never matters.
    const slots = shuffle(
      Array.from({ length: count }, (_, i) => i),
      this.#rng,
    );

    this.marbles = names.map((name, index) => {
      const slot = slots[index];
      return {
        index,
        name,
        color: marbleColor(index),
        x: COURSE.left + (slot + 0.5) * slotWidth,
        y: COURSE.releaseY,
        vx: (this.#rng() * 2 - 1) * 24,
        vy: this.#rng() * 16,
        r: radius,
        trail: [],
        best: COURSE.releaseY,
        rank: index,
        finished: false,
        finishTime: 0,
        boost: 0,
        assist: 0,
        stall: 0,
        spin: this.#rng() * Math.PI * 2,
      };
    });

    this.standings = this.marbles.slice();
    driveObstacles(course, 0);
  }

  static isOut(m: Marble, course: Course): boolean {
    return m.y > course.height + 60;
  }

  /** Advances by exactly FIXED_DT. Call it from an accumulator loop. */
  step(): void {
    const dt = FIXED_DT;
    const course = this.course;
    this.time += dt;

    driveObstacles(course, this.time);

    for (const m of this.marbles) {
      if (Simulation.isOut(m, course)) continue;

      m.vy += GRAVITY * dt;
      if (m.boost > 0) m.boost = Math.max(0, m.boost - dt);

      this.#rescue(m, dt);

      const damp = 1 - DRAG * dt;
      m.vx *= damp;
      m.vy *= damp;

      const speed = Math.hypot(m.vx, m.vy);
      if (speed > MAX_SPEED) {
        m.vx = (m.vx / speed) * MAX_SPEED;
        m.vy = (m.vy / speed) * MAX_SPEED;
      }

      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.spin += (m.vx / Math.max(m.r, 1)) * dt;

      this.#collide(m, dt);

      if (m.y > m.best) {
        m.best = m.y;
        m.stall = 0;
      }

      if (!m.finished && m.y > course.finishY) {
        m.finished = true;
        m.finishTime = this.time;
        this.finishedCount++;
        this.finishOrder.push(m);
        if (!this.winner) {
          this.winner = m;
          this.winTime = this.time;
        }
      }
    }

    this.#separate();
  }

  #collide(m: Marble, dt: number): void {
    const index = this.#index;
    const bucket = Math.max(0, Math.min(index.count - 1, Math.floor(m.y / index.bucketSize)));
    const from = Math.max(0, bucket - 1);
    const to = Math.min(index.count - 1, bucket + 1);

    // Side rails are a simple clamp: they run the whole length of the course.
    if (m.x - m.r < COURSE.left) {
      m.x = COURSE.left + m.r;
      if (m.vx < 0) {
        m.vx = -m.vx * WALL_RESTITUTION;
        m.vy *= 0.99;
      }
    } else if (m.x + m.r > COURSE.right) {
      m.x = COURSE.right - m.r;
      if (m.vx > 0) {
        m.vx = -m.vx * WALL_RESTITUTION;
        m.vy *= 0.99;
      }
    }

    for (let i = from; i <= to; i++) {
      for (const peg of index.pegs[i]) this.#hitPeg(m, peg);
      for (const wall of index.walls[i]) this.#hitSegment(m, wall);
      for (const obstacle of index.obstacles[i]) this.#hitObstacle(m, obstacle);
      for (const pad of index.boosters[i]) this.#boost(m, pad, dt);
    }
  }

  /**
   * Rescue pull for a marble that stopped descending. `stall` counts the time
   * since the marble last reached a new deepest point, so a marble merely
   * bouncing on the spot still counts as stuck.
   */
  #rescue(m: Marble, dt: number): void {
    m.stall += dt;
    if (m.stall > 1.2) m.assist = Math.min(1, m.assist + dt * 0.9);
    else m.assist = Math.max(0, m.assist - dt * 1.2);

    if (m.assist > 0) {
      const centre = (COURSE.left + COURSE.right) / 2;
      m.vx += Math.sign(centre - m.x) * m.assist * 240 * dt;
      m.vy += m.assist * 2600 * dt;
    }

    // Wedged for good: nudge it out of the pocket. Rare, but it keeps the
    // promise that every race finishes.
    if (m.stall > 4) {
      m.stall = 2;
      m.x += ((COURSE.left + COURSE.right) / 2 - m.x) * 0.3;
      m.y += 30;
      m.vx *= 0.2;
      m.vy = Math.max(m.vy, 160);
    }
  }

  #boost(m: Marble, pad: Booster, dt: number): void {
    if (m.x < pad.x || m.x > pad.x + pad.w || m.y < pad.y || m.y > pad.y + pad.h) return;
    m.vy += pad.force * dt;
    m.boost = 0.45;
  }

  #hitPeg(m: Marble, peg: Peg): void {
    const dx = m.x - peg.x;
    const dy = m.y - peg.y;
    const min = m.r + peg.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return;

    const d = Math.sqrt(d2) || 0.0001;
    const nx = dx / d;
    const ny = dy / d;

    m.x = peg.x + nx * min;
    m.y = peg.y + ny * min;

    const vn = m.vx * nx + m.vy * ny;
    if (vn >= 0) return;

    const tx = -ny;
    const ty = nx;
    const vt = m.vx * tx + m.vy * ty;
    const restitution = peg.bumper ? BUMPER_RESTITUTION : PEG_RESTITUTION;
    const kick = peg.bumper ? BUMPER_KICK : 0;

    // A touch of tangential noise breaks the perfectly symmetric hits that
    // would otherwise drop a marble straight down the middle of the track.
    const noise = (this.#rng() * 2 - 1) * Math.min(90, Math.abs(vn) * 0.2);
    // Resting contacts keep almost all of their tangential speed, otherwise a
    // marble rolling along a surface would be ground to a halt in a few steps.
    const keep = -vn > 80 ? TANGENT_KEEP : 0.996;
    const nextN = -vn * restitution + kick;
    const nextT = vt * keep + noise;

    m.vx = nx * nextN + tx * nextT;
    m.vy = ny * nextN + ty * nextT;

    const strength = Math.min(1, -vn / 620);
    peg.energy = Math.min(1, peg.energy + strength * (peg.bumper ? 1.2 : 0.9) + 0.12);
    if (strength > 0.06) {
      this.impacts.push({
        x: peg.x + nx * peg.r,
        y: peg.y + ny * peg.r,
        nx,
        ny,
        strength,
        bumper: peg.bumper,
        color: m.color,
      });
    }
  }

  #hitSegment(m: Marble, seg: Segment): void {
    const ex = seg.x2 - seg.x1;
    const ey = seg.y2 - seg.y1;
    const len2 = ex * ex + ey * ey || 1;
    const t = clamp01(((m.x - seg.x1) * ex + (m.y - seg.y1) * ey) / len2);
    const cx = seg.x1 + ex * t;
    const cy = seg.y1 + ey * t;

    const dx = m.x - cx;
    const dy = m.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= m.r * m.r) return;

    const d = Math.sqrt(d2) || 0.0001;
    const nx = dx / d;
    const ny = dy / d;

    m.x = cx + nx * m.r;
    m.y = cy + ny * m.r;

    const vn = m.vx * nx + m.vy * ny;
    if (vn >= 0) return;

    const tx = -ny;
    const ty = nx;
    const vt = m.vx * tx + m.vy * ty;

    const keep = -vn > 80 ? 0.94 : 0.997;
    m.vx = nx * -vn * WALL_RESTITUTION + tx * vt * keep;
    m.vy = ny * -vn * WALL_RESTITUTION + ty * vt * keep;

    const strength = Math.min(1, -vn / 900);
    if (strength > 0.18) {
      this.impacts.push({ x: cx, y: cy, nx, ny, strength: strength * 0.6, bumper: false, color: m.color });
    }
  }

  /**
   * Moving obstacles are solved in their own rotating frame, then the contact
   * point's surface velocity is added back, so a spinning arm actually throws
   * the marble instead of just blocking it.
   */
  #hitObstacle(m: Marble, o: Obstacle): void {
    const px = o.pivotX + o.ox;
    const py = o.pivotY + o.oy;
    const dx = m.x - px;
    const dy = m.y - py;
    if (Math.abs(dx) > o.reach + m.r || Math.abs(dy) > o.reach + m.r) return;

    const cos = Math.cos(o.angle);
    const sin = Math.sin(o.angle);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;

    for (const part of o.parts) {
      const hit = closestOnPart(part, lx, ly);
      const min = m.r + hit.r;
      const gx = lx - hit.x;
      const gy = ly - hit.y;
      const d2 = gx * gx + gy * gy;
      if (d2 >= min * min) continue;

      const d = Math.sqrt(d2) || 0.0001;
      // Local normal, rotated back into world space.
      const lnx = gx / d;
      const lny = gy / d;
      const nx = lnx * cos - lny * sin;
      const ny = lnx * sin + lny * cos;

      const overlap = min - d;
      m.x += nx * overlap;
      m.y += ny * overlap;

      const contactX = m.x - nx * m.r;
      const contactY = m.y - ny * m.r;
      const rx = contactX - px;
      const ry = contactY - py;
      const svx = o.vx - o.spin * ry;
      const svy = o.vy + o.spin * rx;

      const rvx = m.vx - svx;
      const rvy = m.vy - svy;
      const vn = rvx * nx + rvy * ny;
      if (vn >= 0) continue;

      const tx = -ny;
      const ty = nx;
      const vt = rvx * tx + rvy * ty;
      const noise = (this.#rng() * 2 - 1) * Math.min(70, Math.abs(vn) * 0.15);
      const keep = -vn > 80 ? 0.92 : 0.996;

      m.vx = svx + nx * -vn * o.restitution + tx * (vt * keep + noise);
      m.vy = svy + ny * -vn * o.restitution + ty * (vt * keep + noise);

      const strength = Math.min(1, -vn / 700);
      if (strength > 0.05) {
        this.impacts.push({ x: contactX, y: contactY, nx, ny, strength, bumper: o.hot, color: m.color });
      }
    }
  }

  /** Equal-mass marble/marble resolution with positional correction. */
  #separate(): void {
    const marbles = this.marbles;
    for (let i = 0; i < marbles.length; i++) {
      const a = marbles[i];
      if (Simulation.isOut(a, this.course)) continue;

      for (let j = i + 1; j < marbles.length; j++) {
        const b = marbles[j];
        if (Simulation.isOut(b, this.course)) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 === 0) continue;

        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        const overlap = (min - d) * 0.5;

        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn >= 0) continue;

        const impulse = -(1 + MARBLE_RESTITUTION) * rvn * 0.5;
        a.vx -= nx * impulse;
        a.vy -= ny * impulse;
        b.vx += nx * impulse;
        b.vy += ny * impulse;
      }
    }
  }

  /** Refreshes the standings. Called once per rendered frame. */
  updateStandings(): void {
    this.standings.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.best - a.best;
    });
    for (let i = 0; i < this.standings.length; i++) this.standings[i].rank = i;
    const leader = this.standings[0];
    const second = this.standings[1];
    this.gap = leader && second ? leader.best - second.best : 0;
  }

  /** Samples the trail. Called once per rendered frame, not per physics step. */
  sampleTrails(): void {
    for (const m of this.marbles) {
      if (Simulation.isOut(m, this.course)) {
        if (m.trail.length) m.trail.length = 0;
        continue;
      }
      m.trail.push(m.x, m.y);
      if (m.trail.length > TRAIL_LENGTH * 2) m.trail.splice(0, m.trail.length - TRAIL_LENGTH * 2);
    }
  }

  /** Decays peg flashes with wall-clock time. */
  decay(dt: number): void {
    for (const peg of this.course.pegs) {
      if (peg.energy > 0) peg.energy = Math.max(0, peg.energy - dt * 2.6);
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Closest point on a part to a local space position, plus the part radius. */
function closestOnPart(part: ObstaclePart, lx: number, ly: number): { x: number; y: number; r: number } {
  if (part.kind === 'circle') return { x: part.cx, y: part.cy, r: part.r };

  const ex = part.bx - part.ax;
  const ey = part.by - part.ay;
  const len2 = ex * ex + ey * ey || 1;
  const t = clamp01(((lx - part.ax) * ex + (ly - part.ay) * ey) / len2);
  return { x: part.ax + ex * t, y: part.ay + ey * t, r: part.r };
}
