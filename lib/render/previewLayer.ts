/**
 * The 3D course preview.
 *
 * The same course data the race runs on, lifted off the board: pegs and
 * bumpers become cylinders, rails become walls, spinner arms become raised
 * capsules, and everything casts a shadow from a single directional light.
 * Vertices are projected here and handed to ThorVG as ordinary vector paths.
 *
 * Paints are kept low by slicing the scene into depth bands and batching each
 * band by colour, so a few hundred solids cost a few dozen paints.
 */

import type { Animation, Matrix, Picture, RadialGradient, Scene, Shape, ThorVGNamespace } from '@thorvg/webcanvas';
import { COURSE, MAX_NAMES } from '../course';
import { clamp } from '../easing';
import { UI, darken, lighten, mix } from '../palette';
import {
  LIGHT,
  Projector,
  SHADOW_SLIDE,
  lambert,
  quantise,
  shade,
  type CameraPose,
  type FlatView,
  type Projected,
} from '../preview';
import { skinKey, skinPayload, type Skin } from '../skins';
import type { Course, Marble, Obstacle, RGB } from '../types';
import { advanceArt, artAlpha, artPaint, hideArt, loadArt, makeArtSlot, maskArt, sizeArt, type ArtSlot } from './artwork';
import { ColorPool, addCapsulePath, type Viewport } from './common';

const SLICES = 12;
/** Anything closer than this is behind or on top of the lens, so it is dropped. */
const NEAR = 130;

const HEIGHT = {
  peg: 21,
  bumper: 30,
  rail: 32,
  arm: 30,
  wall: 24,
};

const FLOOR: RGB = [26, 30, 38];
const FLOOR_FAR: RGB = [12, 14, 19];
const GRID: RGB = [86, 104, 130];

export interface PreviewFrame {
  pose: CameraPose;
  viewport: Viewport;
  flat: FlatView;
  marbles: readonly Marble[];
  /** Global fade, so the preview can dissolve into the flat board. */
  alpha: number;
  /** Marble the camera is riding, which must not be drawn in front of it. */
  hideMarble?: number;
  /** Run clock, used to advance an animated marble skin. */
  time: number;
}

/**
 * A marble's artwork in the 3D view. The texture is drawn larger than the
 * ball and clipped to its silhouette, so only the middle of it lands on the
 * visible face and it reads as wrapped rather than pasted on flat; the sphere
 * shading over the top supplies the curvature.
 */
interface SkinSlot {
  clipper: Shape;
  clipperAnim: Shape;
  picture: Picture;
  animation: Animation;
  shade: Shape;
  shadeFill: RadialGradient;
  kind: 'none' | 'picture' | 'animation';
  key: string;
  frames: number;
  fps: number;
}

/** How much wider than the ball the texture is drawn. */
const WRAP = 1.34;
/** Radius the shading gradients are authored at. */
const SHADE_UNIT = 100;

interface Item {
  depth: number;
  draw: (side: ColorPool, top: ColorPool) => void;
}

/**
 * Least squares affine mapping a decal's own rectangle onto four projected
 * corners. Exact whenever the quad really is affine — looking straight down,
 * or once the preview has flattened onto the board — and the closest affine
 * to the true perspective the rest of the time.
 */
function fitAffine(
  a: Projected,
  b: Projected,
  c: Projected,
  d: Projected,
  width: number,
  height: number,
): Matrix | null {
  if (width <= 0 || height <= 0) return null;

  // Corners in the source rectangle's unit space: a=(0,0) b=(1,0) c=(1,1) d=(0,1).
  const solve = (p0: number, p1: number, p2: number, p3: number) => {
    const sum = p0 + p1 + p2 + p3;
    return {
      u: p1 + p2 - 0.5 * sum,
      v: p2 + p3 - 0.5 * sum,
      c: 0.75 * sum - 0.5 * (p1 + p2) - 0.5 * (p2 + p3),
    };
  };

  const x = solve(a.x, b.x, c.x, d.x);
  const y = solve(a.y, b.y, c.y, d.y);

  // Edge on, the mapping collapses and the texture would smear across the view.
  if (Math.abs(x.u * y.v - x.v * y.u) < 1) return null;

  return {
    e11: x.u / width,
    e12: x.v / height,
    e13: x.c,
    e21: y.u / width,
    e22: y.v / height,
    e23: y.c,
    e31: 0,
    e32: 0,
    e33: 1,
  };
}

export class PreviewLayer {
  #course: Course;
  #projector = new Projector();
  #ground: ColorPool;
  #shadows: ColorPool;
  #sides: ColorPool[] = [];
  #tops: ColorPool[] = [];
  #items: Item[] = [];
  #skins: SkinSlot[] = [];
  #decals: Array<{ slot: ArtSlot; clipper: Shape }> = [];
  #decalScene: Scene;
  #tvg: ThorVGNamespace;
  #time = 0;

  constructor(tvg: ThorVGNamespace, root: Scene, course: Course) {
    this.#course = course;
    this.#tvg = tvg;

    const layer = () => {
      const scene = new tvg.Scene();
      root.add(scene);
      return new ColorPool(tvg, scene);
    };

    this.#ground = layer();

    // Artwork sits on the floor: over the ground quads, under the shadows and
    // under everything that stands up off the board.
    this.#decalScene = new tvg.Scene();
    root.add(this.#decalScene);

    this.#shadows = layer();
    for (let i = 0; i < SLICES; i++) {
      this.#sides.push(layer());
      this.#tops.push(layer());
    }

    // Marble artwork sits above the depth slices: a Picture cannot join the
    // colour batches, and a marble is nearly always the closest thing anyway.
    const skinScene = new tvg.Scene();
    root.add(skinScene);
    for (let i = 0; i < MAX_NAMES; i++) this.#skins.push(makeSkinSlot(tvg, skinScene));
  }

  /** The course is only read while drawing, so a new one is a field swap. */
  setCourse(course: Course): void {
    this.#course = course;
  }

  /** Loads the artwork each runner carries. Mirrors the flat marble layer. */
  configureSkins(marbles: readonly Marble[], skinFor: (name: string) => Skin | undefined): void {
    for (let i = 0; i < this.#skins.length; i++) {
      const slot = this.#skins[i];
      const marble = marbles[i];
      applySkin(slot, marble ? skinFor(marble.name) : undefined);
    }
  }

  /** Empties every paint, used while the preview is not on screen. */
  clear(): void {
    for (const slot of this.#skins) hideSkin(slot);
    for (const decal of this.#decals) hideArt(decal.slot);
    this.#ground.begin();
    this.#ground.finish();
    this.#shadows.begin();
    this.#shadows.finish();
    for (let i = 0; i < SLICES; i++) {
      this.#sides[i].begin();
      this.#sides[i].finish();
      this.#tops[i].begin();
      this.#tops[i].finish();
    }
  }

  update(frame: PreviewFrame): void {
    const { pose, viewport, flat } = frame;
    const alpha = clamp(frame.alpha, 0, 1);
    if (alpha <= 0.002) {
      this.clear();
      return;
    }

    this.#time = frame.time;
    this.#projector.update(pose, viewport.width, viewport.height, flat);
    for (const slot of this.#skins) hideSkin(slot);

    this.#ground.begin();
    this.#shadows.begin();
    for (let i = 0; i < SLICES; i++) {
      this.#sides[i].begin();
      this.#tops[i].begin();
    }
    this.#items.length = 0;

    const from = Math.max(pose.targetY - (pose.behind ?? 1500), this.#projector.eye.y - 90);
    const to = pose.targetY + (pose.ahead ?? 3200);

    this.#drawFloor(from, to, alpha);
    this.#drawDecals(from, to, alpha);
    this.#drawPads(from, to, alpha);
    this.#drawFinish(alpha);
    this.#collectRails(from, to, alpha);
    this.#collectPegs(from, to, alpha);
    this.#collectObstacles(from, to, alpha);
    this.#collectMarbles(frame.marbles, alpha, frame.hideMarble ?? -1);

    // Painter's algorithm: far bands first.
    this.#items.sort((a, b) => b.depth - a.depth);
    const count = this.#items.length || 1;
    for (let i = 0; i < this.#items.length; i++) {
      const slice = Math.min(SLICES - 1, Math.floor((i * SLICES) / count));
      this.#items[i].draw(this.#sides[slice], this.#tops[slice]);
    }

    this.#ground.finish();
    this.#shadows.finish();
    for (let i = 0; i < SLICES; i++) {
      this.#sides[i].finish();
      this.#tops[i].finish();
    }
  }

  /* ------------------------------------------------------------- helpers */

  #quad(pool: ColorPool, color: RGB, alpha: number, a: Projected, b: Projected, c: Projected, d: Projected): void {
    const shape = pool.shape(quantise(color), Math.round(alpha * 255));
    shape.moveTo(a.x, a.y);
    shape.lineTo(b.x, b.y);
    shape.lineTo(c.x, c.y);
    shape.lineTo(d.x, d.y);
    shape.close();
  }

  /** A circle lying on the board, drawn as its projected ellipse. */
  #disc(pool: ColorPool, color: RGB, alpha: number, p: Projected, radius: number): void {
    const rx = radius * p.scale;
    pool
      .shape(quantise(color), Math.round(alpha * 255))
      .appendCircle(p.x, p.y, rx, Math.max(0.4, rx * this.#projector.groundSquash));
  }

  /**
   * The curved wall of an upright cylinder, from its foot up to `high`. The
   * foot follows the near half of the base ellipse instead of running straight
   * across, which is what makes the solid read as round rather than as a card
   * standing on the board. The top edge is left straight: a cap or the next
   * band up always covers it.
   */
  #drum(pool: ColorPool, color: RGB, alpha: number, low: Projected, high: Projected, radius: number): void {
    const rl = radius * low.scale;
    const rh = radius * high.scale;
    const sag = Math.max(0.4, rl * this.#projector.groundSquash);
    const k = 0.5522847498307936;

    const shape = pool.shape(quantise(color), Math.round(alpha * 255));
    shape.moveTo(high.x - rh, high.y);
    shape.lineTo(low.x - rl, low.y);
    shape.cubicTo(low.x - rl, low.y + sag * k, low.x - rl * k, low.y + sag, low.x, low.y + sag);
    shape.cubicTo(low.x + rl * k, low.y + sag, low.x + rl, low.y + sag * k, low.x + rl, low.y);
    shape.lineTo(high.x + rh, high.y);
    shape.close();
  }

  /**
   * A sliver of light down the lit side of a cylinder wall. `across` is where
   * it sits on the face, -1 at the left silhouette and 1 at the right.
   */
  #sheen(
    pool: ColorPool,
    color: RGB,
    alpha: number,
    low: Projected,
    high: Projected,
    radius: number,
    across: number,
  ): void {
    const squash = this.#projector.groundSquash;
    const shape = pool.shape(quantise(color), Math.round(alpha * 255));
    const edge = (p: Projected, u: number) => ({
      x: p.x + u * radius * p.scale,
      y: p.y + Math.sqrt(Math.max(0, 1 - u * u)) * radius * p.scale * squash,
    });

    const u0 = clamp(across - 0.16, -0.92, 0.92);
    const u1 = clamp(across + 0.16, -0.92, 0.92);
    const a = edge(high, u0);
    const b = edge(high, u1);
    const c = edge(low, u1);
    const d = edge(low, u0);
    shape.moveTo(a.x, a.y);
    shape.lineTo(b.x, b.y);
    shape.lineTo(c.x, c.y);
    shape.lineTo(d.x, d.y);
    shape.close();
  }

  /**
   * The side of a raised capsule between two heights: the outline swept from
   * the lower one up to the upper one, so the ends come out as half cylinders
   * and the flanks as flat faces, with nothing left open between them.
   */
  #slab(
    pool: ColorPool,
    color: RGB,
    alpha: number,
    lowA: Projected,
    lowB: Projected,
    highA: Projected,
    highB: Projected,
    radius: number,
  ): void {
    const shape = pool.shape(quantise(color), Math.round(alpha * 255));
    // Every piece winds the same way as a capsule, so where they overlap they
    // add up instead of cutting a hole in each other.
    const round = (from: Projected, to: Projected) =>
      addCapsulePath(shape, from.x, from.y, to.x, to.y, radius * from.scale);

    round(lowA, lowB);
    round(highA, highB);
    round(lowA, highA);
    round(lowB, highB);

    const corners = [lowA, lowB, highB, highA];
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      const q = corners[(i + 1) % 4];
      area += p.x * q.y - q.x * p.y;
    }
    if (Math.abs(area) < 0.01) return;
    if (area > 0) corners.reverse();
    shape.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) shape.lineTo(corners[i].x, corners[i].y);
    shape.close();
  }

  /**
   * Which side of an upright face the sun lands on, as seen from the camera:
   * -1 is the left silhouette, 1 the right.
   */
  #litSide(x: number, y: number, at: Projected): number {
    const towards = this.#projector.project(x + LIGHT.x * 40, y + LIGHT.y * 40, 0);
    const dx = towards.x - at.x;
    const dy = towards.y - at.y;
    const len = Math.hypot(dx, dy);
    return len < 0.001 ? 0 : (dx / len) * 0.62;
  }

  /* -------------------------------------------------------------- scene */

  #drawFloor(from: number, to: number, alpha: number): void {
    const step = 260;
    const start = Math.floor(from / step) * step;
    const left = COURSE.left - 4;
    const right = COURSE.right + 4;
    const litFloor = shade(FLOOR, lambert(0, 0, 1, 0.5));

    for (let y = start; y < to; y += step) {
      const near = clamp((y - from) / (to - from), 0, 1);
      // Fades into the night at the far end instead of stopping on a hard line.
      const tone = mix(litFloor, FLOOR_FAR, Math.min(1, near * 1.25));

      this.#quad(
        this.#ground,
        tone,
        alpha,
        this.#projector.project(left, y),
        this.#projector.project(right, y),
        this.#projector.project(right, y + step),
        this.#projector.project(left, y + step),
      );

      // Transverse grid line, the cue that sells the depth.
      const fade = alpha * (1 - near) * 0.5;
      if (fade > 0.02) {
        this.#quad(
          this.#ground,
          GRID,
          fade,
          this.#projector.project(left, y),
          this.#projector.project(right, y),
          this.#projector.project(right, y + 3),
          this.#projector.project(left, y + 3),
        );
      }
    }

    // Two lane lines running the length of the visible course.
    for (const x of [COURSE.left + (COURSE.right - COURSE.left) / 3, COURSE.right - (COURSE.right - COURSE.left) / 3]) {
      this.#quad(
        this.#ground,
        GRID,
        alpha * 0.16,
        this.#projector.project(x - 1.5, from),
        this.#projector.project(x + 1.5, from),
        this.#projector.project(x + 1.5, to),
        this.#projector.project(x - 1.5, to),
      );
    }
  }

  /**
   * Map artwork, laid flat on the floor plane.
   *
   * ThorVG transforms are affine, so a picture cannot be given the true
   * perspective warp of a quad receding into the distance. Instead the affine
   * that best fits all four projected corners is solved for and the picture is
   * clipped to the exact quad: the silhouette is then correct to the pixel and
   * only the texture inside it is very slightly off, which on a floor decal at
   * these pitches does not read.
   */
  #drawDecals(from: number, to: number, alpha: number): void {
    const decals = this.#course.decals;

    for (let i = 0; i < decals.length; i++) {
      const decal = decals[i];
      const entry = this.#decalSlot(i);
      const { slot, clipper } = entry;

      if (decal.y + decal.h < from || decal.y > to) {
        hideArt(slot);
        continue;
      }

      loadArt(slot, decal.art);
      const artwork = artPaint(slot);
      if (!artwork) {
        hideArt(slot);
        continue;
      }

      const a = this.#projector.project(decal.x, decal.y);
      const b = this.#projector.project(decal.x + decal.w, decal.y);
      const c = this.#projector.project(decal.x + decal.w, decal.y + decal.h);
      const d = this.#projector.project(decal.x, decal.y + decal.h);
      // A corner behind the lens projects to nonsense, so the whole piece goes.
      if (a.depth < NEAR || b.depth < NEAR || c.depth < NEAR || d.depth < NEAR) {
        hideArt(slot);
        continue;
      }

      const fit = fitAffine(a, b, c, d, decal.w, decal.h);
      if (!fit) {
        hideArt(slot);
        continue;
      }

      sizeArt(slot, decal.w, decal.h);
      artwork.transform(fit).opacity(artAlpha(decal.opacity, alpha));
      maskArt(slot);
      advanceArt(slot, this.#time);

      clipper.reset();
      clipper.moveTo(a.x, a.y);
      clipper.lineTo(b.x, b.y);
      clipper.lineTo(c.x, c.y);
      clipper.lineTo(d.x, d.y);
      clipper.close();
      clipper.fill(255, 255, 255, 255);
    }

    for (let i = decals.length; i < this.#decals.length; i++) hideArt(this.#decals[i].slot);
  }

  #decalSlot(index: number): { slot: ArtSlot; clipper: Shape } {
    let entry = this.#decals[index];
    if (entry) return entry;

    const slot = makeArtSlot(this.#tvg, this.#decalScene);
    // The clipper never joins a scene: it only shapes the paints it is set on.
    const clipper = new this.#tvg.Shape();
    slot.picture.clip(clipper);
    slot.animation.picture?.clip(clipper);

    entry = { slot, clipper };
    this.#decals.push(entry);
    return entry;
  }

  #drawPads(from: number, to: number, alpha: number): void {
    for (const pad of this.#course.boosters) {
      if (pad.y + pad.h < from || pad.y > to) continue;
      this.#quad(
        this.#ground,
        UI.boost,
        alpha * 0.5,
        this.#projector.project(pad.x, pad.y),
        this.#projector.project(pad.x + pad.w, pad.y),
        this.#projector.project(pad.x + pad.w, pad.y + pad.h),
        this.#projector.project(pad.x, pad.y + pad.h),
      );
    }
  }

  #drawFinish(alpha: number): void {
    const y = this.#course.finishY;
    const cell = (COURSE.right - COURSE.left) / 12;

    for (let i = 0; i < 12; i++) {
      const x = COURSE.left + i * cell;
      const tone = i % 2 === 0 ? UI.finish : [24, 28, 38] as RGB;
      this.#quad(
        this.#ground,
        tone,
        alpha * 0.85,
        this.#projector.project(x, y),
        this.#projector.project(x + cell, y),
        this.#projector.project(x + cell, y + 34),
        this.#projector.project(x, y + 34),
      );
    }
  }

  #collectRails(from: number, to: number, alpha: number): void {
    const step = 320;
    const start = Math.floor(from / step) * step;
    const width = 16;
    const topLight = lambert(0, 0, 1);

    for (const [x, inward] of [
      [COURSE.left, 1],
      [COURSE.right, -1],
    ] as const) {
      const faceLight = lambert(inward, 0, 0, 0.3);
      const topTone = shade(darken(UI.trackLight, 0.35), topLight);
      const faceTone = shade(UI.track, faceLight);

      for (let y = start; y < to; y += step) {
        const y1 = y + step;
        const inner = x + inward * (width / 2);
        const outer = x - inward * (width / 2);
        const h = this.#projector.lift(HEIGHT.rail);
        const depth = this.#projector.project(x, (y + y1) / 2, h).depth;
        if (depth < NEAR) continue;

        this.#items.push({
          depth,
          draw: (side, top) => {
            // Inner wall.
            this.#quad(
              side,
              faceTone,
              alpha,
              this.#projector.project(inner, y, 0),
              this.#projector.project(inner, y1, 0),
              this.#projector.project(inner, y1, h),
              this.#projector.project(inner, y, h),
            );
            // Cap.
            this.#quad(
              top,
              topTone,
              alpha,
              this.#projector.project(inner, y, h),
              this.#projector.project(inner, y1, h),
              this.#projector.project(outer, y1, h),
              this.#projector.project(outer, y, h),
            );
          },
        });
      }
    }
  }

  #collectPegs(from: number, to: number, alpha: number): void {
    const topLight = lambert(0, 0, 1);
    const sideLight = lambert(0, -1, 0, 0.26);

    for (const peg of this.#course.pegs) {
      if (peg.y < from || peg.y > to) continue;

      const height = this.#projector.lift(peg.bumper ? HEIGHT.bumper : HEIGHT.peg);
      const base = this.#projector.project(peg.x, peg.y, 0);
      const cap = this.#projector.project(peg.x, peg.y, height);
      const bodyTone = shade(peg.bumper ? UI.bumper : UI.peg, sideLight);
      const capTone = shade(peg.bumper ? UI.bumperLight : UI.pegLight, topLight);
      // A lighter band under the cap turns the hard top edge into a shoulder.
      const shoulderTone = mix(bodyTone, capTone, 0.45);
      const sheenTone = lighten(bodyTone, 0.26);

      if (base.depth < NEAR) continue;
      this.#shadow(peg.x, peg.y, peg.r * 1.05, height, alpha * 0.5);

      this.#items.push({
        depth: base.depth,
        draw: (side, top) => {
          const shoulder = this.#projector.project(peg.x, peg.y, height * 0.74);
          this.#drum(side, bodyTone, alpha, base, cap, peg.r);
          // Both stay in the side pool: only caps go in the top one, so a cap is
          // never painted over by the wall of a neighbour in the same band.
          this.#sheen(side, sheenTone, alpha * 0.55, base, shoulder, peg.r, this.#litSide(peg.x, peg.y, base));
          this.#drum(side, shoulderTone, alpha, shoulder, cap, peg.r);
          this.#disc(top, capTone, alpha, cap, peg.r);
        },
      });
    }
  }

  #collectObstacles(from: number, to: number, alpha: number): void {
    const topLight = lambert(0, 0, 1);
    const sideLight = lambert(0, -1, 0, 0.28);

    for (const obstacle of this.#course.obstacles) {
      if (obstacle.pivotY + obstacle.reach < from || obstacle.pivotY - obstacle.reach > to) continue;
      this.#collectObstacle(obstacle, alpha, topLight, sideLight);
    }
  }

  #collectObstacle(o: Obstacle, alpha: number, topLight: number, sideLight: number): void {
    const cos = Math.cos(o.angle);
    const sin = Math.sin(o.angle);
    const px = o.pivotX + o.ox;
    const py = o.pivotY + o.oy;
    const base: RGB = o.hot ? UI.hot : UI.machine;
    const capTone = shade(lighten(base, 0.32), topLight);
    const bodyTone = shade(darken(base, 0.32), sideLight);
    const shoulderTone = mix(bodyTone, capTone, 0.42);
    const height = this.#projector.lift(HEIGHT.arm);

    const toWorld = (lx: number, ly: number) => ({
      x: px + lx * cos - ly * sin,
      y: py + lx * sin + ly * cos,
    });

    for (const part of o.parts) {
      const a = part.kind === 'circle' ? toWorld(part.cx, part.cy) : toWorld(part.ax, part.ay);
      const b = part.kind === 'circle' ? a : toWorld(part.bx, part.by);
      const radius = part.r;

      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const anchor = this.#projector.project(midX, midY, height);
      if (anchor.depth < NEAR) continue;

      this.#shadow(midX, midY, radius, height, alpha * 0.4, a, b);

      this.#items.push({
        depth: anchor.depth,
        draw: (side, top) => {
          const lowA = this.#projector.project(a.x, a.y, height * 0.25);
          const lowB = this.#projector.project(b.x, b.y, height * 0.25);
          const highA = this.#projector.project(a.x, a.y, height);
          const highB = this.#projector.project(b.x, b.y, height);

          const midA = this.#projector.project(a.x, a.y, height * 0.78);
          const midB = this.#projector.project(b.x, b.y, height * 0.78);

          this.#slab(side, bodyTone, alpha, lowA, lowB, highA, highB, radius);
          this.#slab(side, shoulderTone, alpha, midA, midB, highA, highB, radius);
          addCapsulePath(
            top.shape(quantise(capTone), Math.round(alpha * 255)),
            highA.x,
            highA.y,
            highB.x,
            highB.y,
            radius * highA.scale,
          );
        },
      });
    }
  }

  #collectMarbles(marbles: readonly Marble[], alpha: number, hidden: number): void {
    for (const marble of marbles) {
      if (marble.index === hidden) continue;
      const centre = this.#projector.project(marble.x, marble.y, this.#projector.lift(marble.r * 1.4) + marble.r * 0.2);
      if (centre.depth < NEAR * 0.35) continue;
      this.#shadow(marble.x, marble.y, marble.r, this.#projector.lift(marble.r * 1.4), alpha * 0.45);

      const lit = shade(lighten(marble.color, 0.35), lambert(0, 0, 1, 0.7));
      const dark = shade(marble.color, 0.55);
      const slot = this.#skins[marble.index];
      const skinned = !!slot && slot.kind !== 'none';

      this.#items.push({
        depth: centre.depth,
        draw: (side, top) => {
          const r = marble.r * centre.scale;
          // The ball is always laid down first, so artwork with holes in it
          // still sits on a solid marble rather than on the board.
          side.shape(quantise(dark), Math.round(alpha * 255)).appendCircle(centre.x, centre.y, r);
          if (skinned) {
            this.#wrapSkin(slot, centre.x, centre.y, r, alpha);
            return;
          }
          top
            .shape(quantise(lit), Math.round(alpha * 210))
            .appendCircle(centre.x - r * 0.24, centre.y - r * 0.28, r * 0.6);
        },
      });
    }
  }

  /**
   * Lays a marble's artwork onto its projected disc. The texture is drawn
   * oversized and clipped to the circle so its edges never show, and a radial
   * shade with a light-side highlight bends it into a ball.
   */
  #wrapSkin(slot: SkinSlot, x: number, y: number, r: number, alpha: number): void {
    if (r < 1.5) return;

    const clipper = slot.kind === 'animation' ? slot.clipperAnim : slot.clipper;
    clipper.reset();
    clipper.appendCircle(x, y, r).fill(255, 255, 255, 255);

    const size = r * 2 * WRAP;
    const artwork = slot.kind === 'animation' ? slot.animation.picture : slot.picture;
    artwork?.opacity(Math.round(alpha * 255)).size(size, size).translate(x - size / 2, y - size / 2);

    if (slot.kind === 'animation' && slot.frames > 1) {
      slot.animation.frame((this.#time * slot.fps) % slot.frames);
    }

    // The gradient is authored at SHADE_UNIT, so it only needs scaling here.
    slot.shade
      .opacity(Math.round(alpha * 255))
      .scale(r / SHADE_UNIT)
      .translate(x, y);
  }

  /** Drops a soft blob on the board, offset along the light direction. */
  #shadow(
    x: number,
    y: number,
    radius: number,
    height: number,
    alpha: number,
    a?: { x: number; y: number },
    b?: { x: number; y: number },
  ): void {
    if (alpha <= 0.01) return;

    const offX = height * SHADOW_SLIDE.x;
    const offY = height * SHADOW_SLIDE.y;
    const spread = 1 + height * 0.004;

    if (a && b) {
      const pa = this.#projector.project(a.x + offX, a.y + offY, 0);
      const pb = this.#projector.project(b.x + offX, b.y + offY, 0);
      addCapsulePath(
        this.#shadows.shape([4, 5, 8], Math.round(alpha * 150)),
        pa.x,
        pa.y,
        pb.x,
        pb.y,
        radius * spread * pa.scale,
      );
      return;
    }

    const p = this.#projector.project(x + offX, y + offY, 0);
    this.#disc(this.#shadows, [4, 5, 8], alpha * 0.6, p, radius * spread);
  }

  /** Where a world point lands on screen, used for framing helpers. */
  project(x: number, y: number, z = 0): Projected {
    return this.#projector.project(x, y, z);
  }
}

/* ------------------------------------------------------- marble skins */

function makeSkinSlot(tvg: ThorVGNamespace, scene: Scene): SkinSlot {
  const clipper = new tvg.Shape();
  const picture = new tvg.Picture();
  picture.clip(clipper);
  scene.add(picture);

  // A clipper binds to one paint, so the animated artwork gets its own.
  const clipperAnim = new tvg.Shape();
  const animation = new tvg.Animation();
  const animPicture = animation.picture;
  if (animPicture) {
    animPicture.clip(clipperAnim);
    scene.add(animPicture);
  }

  // Sphere shading: clear where the light lands, deepening to a dark rim.
  const shadeFill = new tvg.RadialGradient(
    0,
    0,
    SHADE_UNIT,
    -SHADE_UNIT * 0.34,
    -SHADE_UNIT * 0.4,
    0,
  );
  shadeFill.setStops(
    [0, [255, 255, 255, 96]],
    [0.26, [255, 255, 255, 18]],
    [0.62, [0, 0, 0, 0]],
    [0.88, [0, 0, 0, 92]],
    [1, [0, 0, 0, 170]],
  );
  const shadeShape = new tvg.Shape();
  shadeShape.appendCircle(0, 0, SHADE_UNIT).fill(shadeFill);
  scene.add(shadeShape);

  const slot: SkinSlot = {
    clipper,
    clipperAnim,
    picture,
    animation,
    shade: shadeShape,
    shadeFill,
    kind: 'none',
    key: '',
    frames: 0,
    fps: 30,
  };
  hideSkin(slot);
  return slot;
}

function applySkin(slot: SkinSlot, skin: Skin | undefined): void {
  const key = skinKey(skin);
  if (key === slot.key) return;

  slot.key = key;
  slot.kind = 'none';
  slot.frames = 0;
  if (!skin) return;

  const payload = skinPayload(skin);
  if (!payload) return;

  if (skin.type === 'lot') {
    slot.animation.load(payload as string);
    const info = slot.animation.info();
    slot.frames = info?.totalFrames ?? 0;
    slot.fps = info?.fps || 30;
    slot.kind = 'animation';
    return;
  }

  slot.picture.load(payload, { type: skin.type });
  slot.kind = 'picture';
}

/**
 * Hidden with zero opacity rather than `visible(false)`, which asks the
 * backend for a region a never-rendered paint does not have.
 */
function hideSkin(slot: SkinSlot): void {
  slot.picture.opacity(0);
  slot.animation.picture?.opacity(0);
  slot.shade.opacity(0);
}
