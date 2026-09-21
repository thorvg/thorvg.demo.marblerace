/**
 * Race camera: follows the leader, zooms in when the front of the field is
 * tight and pulls back when it spreads out, and shakes on heavy hits.
 */

import { COURSE } from './course';
import { clamp, lerp } from './easing';
import type { Marble } from './types';

export const ZOOM = { min: 0.72, max: 1.7 } as const;

/** The map editor needs to pull further out and push further in than a race. */
export const EDIT_ZOOM = { min: 0.3, max: 3.2 } as const;

export interface CameraView {
  x: number;
  y: number;
  zoom: number;
}

export class Camera {
  x = COURSE.width / 2;
  y = 0;
  zoom = 1;

  #targetX = COURSE.width / 2;
  #targetY = 0;
  #targetZoom = 1;
  #shake = 0;
  #punch = 0;
  #shakeSeed = Math.random() * 1000;
  /** Visible world box at zoom 1, kept in sync by the renderer. */
  #viewW: number = COURSE.viewWidth;
  #viewH: number = COURSE.viewHeight;
  #minZoom: number = ZOOM.min;
  #maxZoom: number = ZOOM.max;

  setView(worldWidth: number, worldHeight: number): void {
    this.#viewW = worldWidth;
    this.#viewH = worldHeight;
  }

  /** Widened while the map editor is open, restored when it closes. */
  setZoomRange(min: number, max: number): void {
    this.#minZoom = min;
    this.#maxZoom = max;
    this.zoom = clamp(this.zoom, min, max);
    this.#targetZoom = clamp(this.#targetZoom, min, max);
  }

  get zoomRange(): { min: number; max: number } {
    return { min: this.#minZoom, max: this.#maxZoom };
  }

  /** Visible world height at the current zoom. */
  get viewHeight(): number {
    return this.#viewH / this.zoom;
  }

  snap(x: number, y: number, zoom: number): void {
    this.x = this.#targetX = x;
    this.y = this.#targetY = y;
    this.zoom = this.#targetZoom = clamp(zoom, this.#minZoom, this.#maxZoom);
  }

  aim(x: number, y: number, zoom: number): void {
    this.#targetX = x;
    this.#targetY = y;
    this.#targetZoom = clamp(zoom, this.#minZoom, this.#maxZoom);
  }

  kick(amount: number): void {
    this.#shake = Math.min(1, this.#shake + amount);
  }

  /** A short push in, used when something worth watching happens. */
  punch(amount: number): void {
    this.#punch = Math.min(0.35, this.#punch + amount);
  }

  /** Frames the leading marbles. */
  follow(standings: readonly Marble[], finishY: number): void {
    const leader = standings.find((m) => !m.finished) ?? standings[0];
    if (!leader) return;

    // How far the chasing pack trails the leader decides the zoom.
    let spread = 0;
    let seen = 0;
    for (const m of standings) {
      if (m.finished) continue;
      spread = Math.max(spread, leader.best - m.best);
      if (++seen >= 3) break;
    }

    const tight = clamp(1 - spread / 520, 0, 1);
    let zoom = lerp(0.8, 1.34, tight) + this.#punch;

    // Closing on the finish line: push in for the run home.
    const toFinish = finishY - leader.y;
    if (toFinish < 1100) zoom = Math.max(zoom, lerp(1.05, 1.5, clamp(1 - toFinish / 1100, 0, 1)));

    const viewH = this.#viewH / zoom;
    // Keep the leader slightly above centre so the track ahead stays visible.
    const y = leader.y + viewH * 0.14;

    const halfWidth = this.#viewW / zoom / 2;
    const minX = COURSE.left + halfWidth;
    const maxX = COURSE.right - halfWidth;
    const x = minX > maxX ? COURSE.width / 2 : clamp(leader.x, minX, maxX);

    this.aim(x, y, zoom);
  }

  update(dt: number): CameraView {
    const k = (rate: number) => 1 - Math.exp(-rate * dt);

    this.x = lerp(this.x, this.#targetX, k(5));
    this.y = lerp(this.y, this.#targetY, k(7.5));
    this.zoom = lerp(this.zoom, this.#targetZoom, k(2.4));

    this.#shake = Math.max(0, this.#shake - dt * 2.2);
    this.#punch = Math.max(0, this.#punch - dt * 0.5);

    if (this.#shake <= 0.001) return { x: this.x, y: this.y, zoom: this.zoom };

    // Two out of phase sines read as a punchy rattle without a random walk.
    const t = (this.#shakeSeed += dt * 42);
    const amount = this.#shake * this.#shake * 26;
    return {
      x: this.x + Math.sin(t * 1.7) * amount,
      y: this.y + Math.cos(t * 2.3) * amount * 0.7,
      zoom: this.zoom,
    };
  }
}
