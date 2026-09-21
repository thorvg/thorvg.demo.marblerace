/** Particle systems. Pure data - the renderer only reads these arrays. */

import type { RGB } from './types';
import type { Rng } from './rng';
import { lighten } from './palette';

export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: RGB;
}

export interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  w: number;
  h: number;
  flip: number;
  flipSpeed: number;
  life: number;
  max: number;
  color: RGB;
}

export interface Shockwave {
  x: number;
  y: number;
  r: number;
  vr: number;
  width: number;
  life: number;
  max: number;
  color: RGB;
}

export interface Sparkle {
  x: number;
  y: number;
  size: number;
  rot: number;
  life: number;
  max: number;
  color: RGB;
}

const MAX_SPARKS = 240;
const MAX_CONFETTI = 260;

export class Fx {
  readonly sparks: Spark[] = [];
  readonly confetti: Confetti[] = [];
  readonly waves: Shockwave[] = [];
  readonly sparkles: Sparkle[] = [];

  #rng: Rng;

  constructor(rng: Rng) {
    this.#rng = rng;
  }

  clear(): void {
    this.sparks.length = 0;
    this.confetti.length = 0;
    this.waves.length = 0;
    this.sparkles.length = 0;
  }

  update(dt: number): void {
    prune(this.sparks, dt, (p) => {
      p.vy += 780 * dt;
      p.vx *= 1 - 1.6 * dt;
      p.vy *= 1 - 1.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    });

    prune(this.confetti, dt, (p) => {
      p.vy += 760 * dt;
      p.vx *= 1 - 0.9 * dt;
      p.vy *= 1 - 0.7 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      p.flip += p.flipSpeed * dt;
    });

    prune(this.waves, dt, (p) => {
      p.r += p.vr * dt;
      p.vr *= 1 - 2.1 * dt;
    });

    prune(this.sparkles, dt, (p) => {
      p.rot += 0.9 * dt;
    });
  }

  /** Small burst thrown off a peg or bumper hit. */
  impact(x: number, y: number, nx: number, ny: number, strength: number, color: RGB, bumper: boolean): void {
    const count = Math.min(bumper ? 8 : 4, Math.round(strength * (bumper ? 9 : 5)) + 1);
    if (this.sparks.length + count > MAX_SPARKS) return;

    const base = Math.atan2(ny, nx);
    for (let i = 0; i < count; i++) {
      const angle = base + (this.#rng() * 2 - 1) * 1.05;
      const speed = (bumper ? 260 : 150) * (0.45 + this.#rng() * 0.9) * (0.5 + strength);
      const life = 0.24 + this.#rng() * 0.3;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        max: life,
        size: (bumper ? 3.4 : 2.4) * (0.7 + this.#rng() * 0.8),
        color: lighten(color, bumper ? 0.45 : 0.3),
      });
    }
  }

  shockwave(x: number, y: number, color: RGB, opts: { r?: number; vr?: number; width?: number; life?: number } = {}): void {
    const life = opts.life ?? 0.85;
    this.waves.push({
      x,
      y,
      r: opts.r ?? 10,
      vr: opts.vr ?? 900,
      width: opts.width ?? 8,
      life,
      max: life,
      color,
    });
  }

  confettiBurst(x: number, y: number, colors: readonly RGB[], count: number, spread = 1): void {
    const room = MAX_CONFETTI - this.confetti.length;
    const n = Math.min(count, room);
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + (this.#rng() * 2 - 1) * (1.25 * spread);
      const speed = 420 + this.#rng() * 760;
      const life = 2.4 + this.#rng() * 2.2;
      this.confetti.push({
        x: x + (this.#rng() * 2 - 1) * 18,
        y: y + (this.#rng() * 2 - 1) * 18,
        vx: Math.cos(angle) * speed * 0.85,
        vy: Math.sin(angle) * speed,
        rot: this.#rng() * Math.PI * 2,
        vrot: (this.#rng() * 2 - 1) * 7,
        w: 9 + this.#rng() * 9,
        h: 5 + this.#rng() * 7,
        flip: this.#rng() * Math.PI * 2,
        flipSpeed: 4 + this.#rng() * 7,
        life,
        max: life,
        color: colors[Math.floor(this.#rng() * colors.length)],
      });
    }
  }

  sparkleBurst(x: number, y: number, radius: number, count: number, color: RGB): void {
    for (let i = 0; i < count; i++) {
      const angle = this.#rng() * Math.PI * 2;
      const dist = radius * (0.65 + this.#rng() * 0.7);
      const life = 0.6 + this.#rng() * 0.9;
      this.sparkles.push({
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        size: 7 + this.#rng() * 13,
        rot: this.#rng() * Math.PI,
        life,
        max: life,
        color,
      });
    }
  }
}

function prune<T extends { life: number }>(list: T[], dt: number, advance: (p: T) => void): void {
  let write = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    advance(p);
    list[write++] = p;
  }
  list.length = write;
}
