/**
 * Perspective projection for the course preview.
 *
 * ThorVG's paint transform is affine, so the perspective divide happens here:
 * the course is treated as a 3D scene (the board is the z = 0 plane, pegs and
 * rails stand up from it), every vertex is projected to screen space in JS and
 * ThorVG rasterises the resulting vector geometry.
 *
 * At the end of the preview the projection morphs into the flat 2D race view,
 * so the fly around lands exactly on the board the race is played on.
 */

import { clamp, lerp } from './easing';
import type { RGB } from './types';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Projected {
  x: number;
  y: number;
  /** Camera space depth. Negative means the point sits behind the camera. */
  depth: number;
  /** Screen pixels per world unit at this depth. */
  scale: number;
}

export interface CameraPose {
  /** Look-at point on the board. */
  targetX: number;
  targetY: number;
  /** Distance from the target. */
  distance: number;
  /** Rotation around the vertical axis, radians. 0 looks down the course. */
  yaw: number;
  /** 0 is level with the board, PI/2 is straight down. */
  pitch: number;
  /** Vertical field of view, radians. */
  fov: number;
  /** 0 keeps the full perspective, 1 lands on the flat 2D view. */
  flatten: number;
  /** Set to place the camera by hand instead of orbiting the target. */
  eye?: Vec3;
  /** Where a hand placed camera looks. */
  lookAt?: Vec3;
  /** How far behind the target to keep drawing. */
  behind?: number;
  /** How far ahead of the target to keep drawing. */
  ahead?: number;
}

/** Sun direction, pointing from the scene towards the light. */
export const LIGHT: Vec3 = normalise({ x: -0.42, y: -0.34, z: 0.84 });

/** How far a shadow slides per unit of height. */
export const SHADOW_SLIDE = { x: -LIGHT.x / LIGHT.z, y: -LIGHT.y / LIGHT.z };

function normalise(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Flat view mapping, matching the 2D race camera exactly. */
export interface FlatView {
  scale: number;
  ox: number;
  oy: number;
}

export class Projector {
  #eye: Vec3 = { x: 0, y: 0, z: 0 };
  #right: Vec3 = { x: 1, y: 0, z: 0 };
  #up: Vec3 = { x: 0, y: 1, z: 0 };
  #forward: Vec3 = { x: 0, y: 0, z: 1 };
  #focal = 1;
  #halfW = 0;
  #halfH = 0;
  #flatten = 0;
  #flat: FlatView = { scale: 1, ox: 0, oy: 0 };
  #sinPitch = 1;

  /** Rebuilds the camera basis. Call once per frame. */
  update(pose: CameraPose, width: number, height: number, flat: FlatView): void {
    const { targetX, targetY, distance, yaw, pitch, fov } = pose;

    let look: Vec3;

    if (pose.eye && pose.lookAt) {
      // Ride camera: the eye and the aim point are given outright.
      this.#eye = pose.eye;
      look = pose.lookAt;
    } else {
      // The eye orbits the target: yaw spins around it, pitch lifts it up.
      const cosPitch = Math.cos(pitch);
      this.#eye = {
        x: targetX + distance * cosPitch * Math.sin(yaw),
        y: targetY - distance * cosPitch * Math.cos(yaw),
        z: distance * Math.sin(pitch),
      };
      look = { x: targetX, y: targetY, z: 0 };
    }

    const forward = normalise({
      x: look.x - this.#eye.x,
      y: look.y - this.#eye.y,
      z: look.z - this.#eye.z,
    });

    // How steeply the camera looks down decides the ground foreshortening.
    this.#sinPitch = Math.max(0.06, -forward.z);
    const worldUp: Vec3 = { x: 0, y: 0, z: 1 };
    let right = cross(forward, worldUp);
    if (Math.hypot(right.x, right.y, right.z) < 1e-4) right = { x: 1, y: 0, z: 0 };
    right = normalise(right);

    this.#forward = forward;
    this.#right = right;
    this.#up = cross(right, forward);

    this.#halfW = width / 2;
    this.#halfH = height / 2;
    this.#focal = this.#halfH / Math.tan(fov / 2);
    this.#flatten = clamp(pose.flatten, 0, 1);
    this.#flat = flat;
  }

  get flatten(): number {
    return this.#flatten;
  }

  get eye(): Vec3 {
    return this.#eye;
  }

  /** Foreshortening of the ground plane, 1 when looking straight down. */
  get groundSquash(): number {
    return lerp(Math.max(0.06, this.#sinPitch), 1, this.#flatten);
  }

  project(x: number, y: number, z = 0): Projected {
    const dx = x - this.#eye.x;
    const dy = y - this.#eye.y;
    const dz = z - this.#eye.z;

    const depth = dx * this.#forward.x + dy * this.#forward.y + dz * this.#forward.z;
    const cx = dx * this.#right.x + dy * this.#right.y + dz * this.#right.z;
    const cy = dx * this.#up.x + dy * this.#up.y + dz * this.#up.z;

    const scale = this.#focal / Math.max(1, depth);
    const sx = this.#halfW + cx * scale;
    const sy = this.#halfH - cy * scale;

    if (this.#flatten <= 0) return { x: sx, y: sy, depth, scale };

    // Morph towards the flat board so the preview hands over seamlessly.
    const fx = x * this.#flat.scale + this.#flat.ox;
    const fy = y * this.#flat.scale + this.#flat.oy;
    const t = this.#flatten;

    return {
      x: lerp(sx, fx, t),
      y: lerp(sy, fy, t),
      depth,
      scale: lerp(scale, this.#flat.scale, t),
    };
  }

  /** Height above the board, faded out as the scene flattens. */
  lift(height: number): number {
    return height * (1 - this.#flatten);
  }
}

/** Lambert term for a surface normal, with a soft ambient floor. */
export function lambert(nx: number, ny: number, nz: number, ambient = 0.42): number {
  const dot = nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z;
  return clamp(ambient + Math.max(0, dot) * (1 - ambient), 0, 1.35);
}

/** Multiplies a colour by a light term, keeping it in range. */
export function shade(color: RGB, light: number): RGB {
  return [
    Math.round(clamp(color[0] * light, 0, 255)),
    Math.round(clamp(color[1] * light, 0, 255)),
    Math.round(clamp(color[2] * light, 0, 255)),
  ];
}

/** Quantises a colour so the batching pools stay small. */
export function quantise(color: RGB, step = 12): RGB {
  return [
    Math.round(color[0] / step) * step,
    Math.round(color[1] / step) * step,
    Math.round(color[2] / step) * step,
  ];
}
