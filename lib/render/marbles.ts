/**
 * Marbles: comet trail, glow, lit body and the initial that identifies the
 * runner. Bodies are built once as unit circles and only transformed per
 * frame, so a full field costs a handful of WASM calls.
 */

import type { Animation, Picture, RadialGradient, Scene, Shape, Text, ThorVGNamespace } from '@thorvg/webcanvas';
import { MAX_NAMES } from '../course';
import type { FontResolver } from '../fonts';
import { darken, lighten } from '../palette';
import { skinKey, skinPayload, type Skin } from '../skins';
import type { Marble, RGB } from '../types';

const UNIT = 100;

interface Slot {
  trail: Shape;
  glow: Shape;
  glowFill: RadialGradient;
  body: Shape;
  bodyFill: RadialGradient;
  /**
   * Circles the skin artwork is clipped into. Never added to a scene, and one
   * per artwork paint: ThorVG binds a clipper to a single target.
   */
  clipper: Shape;
  clipperAnim: Shape;
  /** Still artwork: image or svg. */
  picture: Picture;
  /** Animated artwork: lottie. */
  animation: Animation;
  /** Ball shading laid over the artwork so a skin still reads as a marble. */
  gloss: Shape;
  glossFill: RadialGradient;
  label: Text;
  skin: 'none' | 'picture' | 'animation';
  skinKey: string;
  frames: number;
  fps: number;
}

export class MarbleLayer {
  #slots: Slot[] = [];
  #count = 0;
  #leaderRing: Shape;

  constructor(tvg: ThorVGNamespace, trailScene: Scene, bodyScene: Scene) {
    this.#leaderRing = new tvg.Shape();
    trailScene.add(this.#leaderRing);

    for (let i = 0; i < MAX_NAMES; i++) {
      const trail = new tvg.Shape();
      trail.blend(tvg.BlendMethod.Add);
      trailScene.add(trail);

      const glow = new tvg.Shape();
      const glowFill = new tvg.RadialGradient(0, 0, UNIT);
      // No blend method here: the GL backend cannot composite blending with a
      // gradient fill, so the halo is drawn with plain alpha.
      glow.appendCircle(0, 0, UNIT).fill(glowFill);
      bodyScene.add(glow);

      const body = new tvg.Shape();
      const bodyFill = new tvg.RadialGradient(0, 0, UNIT, -UNIT * 0.34, -UNIT * 0.4, 0);
      body.appendCircle(0, 0, UNIT).fill(bodyFill);
      bodyScene.add(body);

      // Skin artwork sits above the plain ball and below the shading.
      const clipper = new tvg.Shape();
      const picture = new tvg.Picture();
      picture.clip(clipper);
      bodyScene.add(picture);

      const clipperAnim = new tvg.Shape();
      const animation = new tvg.Animation();
      const animPicture = animation.picture;
      if (animPicture) {
        animPicture.clip(clipperAnim);
        bodyScene.add(animPicture);
      }

      const gloss = new tvg.Shape();
      const glossFill = new tvg.RadialGradient(0, 0, UNIT, -UNIT * 0.36, -UNIT * 0.42, 0);
      glossFill.setStops(
        [0, [255, 255, 255, 150]],
        [0.3, [255, 255, 255, 26]],
        [0.72, [0, 0, 0, 0]],
        [1, [0, 0, 0, 150]],
      );
      gloss.appendCircle(0, 0, UNIT).fill(glossFill);
      bodyScene.add(gloss);

      const label = new tvg.Text();
      label.align(0.5, 0.5);
      bodyScene.add(label);

      const slot: Slot = {
        trail,
        glow,
        glowFill,
        body,
        bodyFill,
        clipper,
        clipperAnim,
        picture,
        animation,
        gloss,
        glossFill,
        label,
        skin: 'none',
        skinKey: '',
        frames: 0,
        fps: 30,
      };
      this.#hide(slot);
      this.#slots.push(slot);
    }
  }

  /** Applies colours, radii, labels and skins for a new run. */
  configure(marbles: readonly Marble[], fontFor: FontResolver, skinFor: (name: string) => Skin | undefined): void {
    this.#count = Math.min(marbles.length, this.#slots.length);

    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      const marble = marbles[i];
      if (!marble || i >= this.#count) {
        this.#hide(slot);
        continue;
      }

      const color = marble.color;
      const rim = darken(color, 0.55);

      slot.bodyFill.setStops(
        [0, toStop(lighten(color, 0.72))],
        [0.34, toStop(lighten(color, 0.14))],
        [0.82, toStop(color)],
        [1, toStop(darken(color, 0.34))],
      );
      slot.body.fill(slot.bodyFill);
      slot.body.stroke({ width: 9, color: [rim[0], rim[1], rim[2], 220] });

      slot.glowFill.setStops(
        [0, [color[0], color[1], color[2], 150]],
        [0.35, [color[0], color[1], color[2], 72]],
        [1, [color[0], color[1], color[2], 0]],
      );
      slot.glow.fill(slot.glowFill);

      this.#applySkin(slot, skinFor(marble.name), marble.r);

      const initial = Array.from(marble.name.trim())[0] ?? '?';
      const ink = darken(color, 0.68);
      slot.label
        .font(fontFor(initial))
        .text(slot.skin === 'none' ? initial : '')
        .fontSize(marble.r * 1.15)
        .fill(ink[0], ink[1], ink[2]);

      const glowColor = lighten(color, 0.3);
      slot.trail.fill(glowColor[0], glowColor[1], glowColor[2], 96);
    }
  }

  /** Loads or clears the artwork a runner carries. */
  #applySkin(slot: Slot, skin: Skin | undefined, radius: number): void {
    const key = skinKey(skin);
    if (key === slot.skinKey) return;

    slot.skinKey = key;
    slot.skin = 'none';
    slot.frames = 0;

    if (!skin) return;
    const payload = skinPayload(skin);
    if (!payload) return;

    const size = radius * 2;

    if (skin.type === 'lot') {
      slot.animation.load(payload as string);
      const info = slot.animation.info();
      slot.frames = info?.totalFrames ?? 0;
      slot.fps = info?.fps || 30;
      slot.animation.picture?.size(size, size);
      slot.skin = 'animation';
      return;
    }

    slot.picture.load(payload, { type: skin.type });
    slot.picture.size(size, size);
    slot.skin = 'picture';
  }

  update(marbles: readonly Marble[], hiddenIndex: number, worldBottom: number, leader: Marble | null, time: number): void {
    this.#leaderRing.reset();
    if (leader && leader.index !== hiddenIndex && !leader.finished) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 4.2);
      const c = lighten(leader.color, 0.45);
      this.#leaderRing
        .appendCircle(leader.x, leader.y, leader.r * (2 + pulse * 0.25))
        .stroke({
          width: 2.4,
          color: [c[0], c[1], c[2], Math.round(120 + pulse * 90)],
          dash: [9, 11],
        });
    }

    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      const marble = marbles[i];
      if (!marble || i >= this.#count || i === hiddenIndex || marble.y > worldBottom + 60) {
        this.#hide(slot);
        continue;
      }

      const scale = marble.r / UNIT;
      const halo = marble.boost > 0 ? 3.4 : 2.6;
      slot.glow.opacity(marble.boost > 0 ? 255 : 235).scale(scale * halo).translate(marble.x, marble.y);
      slot.label.opacity(slot.skin === 'none' ? 255 : 0).translate(marble.x, marble.y);

      if (slot.skin === 'none') {
        slot.body.opacity(255).scale(scale).translate(marble.x, marble.y);
        slot.gloss.opacity(0);
        continue;
      }

      // Skinned: the artwork is clipped into the marble circle and the ball
      // shading goes over the top.
      slot.body.opacity(0);
      const clipper = slot.skin === 'animation' ? slot.clipperAnim : slot.clipper;
      clipper.reset();
      clipper.appendCircle(marble.x, marble.y, marble.r).fill(255, 255, 255, 255);
      slot.gloss.opacity(255).scale(scale).translate(marble.x, marble.y);

      const artwork = slot.skin === 'animation' ? slot.animation.picture : slot.picture;
      artwork?.opacity(255).translate(marble.x - marble.r, marble.y - marble.r);

      if (slot.skin === 'animation' && slot.frames > 1) {
        slot.animation.frame((time * slot.fps) % slot.frames);
      }

      this.#drawTrail(slot.trail, marble);
    }
  }

  /**
   * Hiding is done with an empty path or zero opacity. ThorVG's visibility
   * toggle asks the backend for a region, which is not available for a paint
   * that has never been rendered.
   */
  #hide(slot: Slot): void {
    slot.trail.reset();
    slot.glow.opacity(0);
    slot.body.opacity(0);
    slot.gloss.opacity(0);
    slot.label.opacity(0);
    slot.picture.opacity(0);
    slot.animation.picture?.opacity(0);
  }

  /** Builds a tapered ribbon through the sampled positions. */
  #drawTrail(shape: Shape, marble: Marble): void {
    const pts = marble.trail;
    const n = pts.length / 2;
    shape.reset();

    if (n < 4) return;

    const left: number[] = [];
    const right: number[] = [];

    for (let i = 0; i < n; i++) {
      const x = pts[i * 2];
      const y = pts[i * 2 + 1];
      const px = pts[Math.max(0, i - 1) * 2];
      const py = pts[Math.max(0, i - 1) * 2 + 1];
      const nx = pts[Math.min(n - 1, i + 1) * 2];
      const ny = pts[Math.min(n - 1, i + 1) * 2 + 1];

      let dx = nx - px;
      let dy = ny - py;
      const len = Math.hypot(dx, dy);
      if (len < 0.0001) {
        dx = 0;
        dy = 1;
      } else {
        dx /= len;
        dy /= len;
      }

      const t = i / (n - 1);
      const w = marble.r * 0.86 * t * t;
      left.push(x - dy * w, y + dx * w);
      right.push(x + dy * w, y - dx * w);
    }

    shape.moveTo(left[0], left[1]);
    for (let i = 1; i < n; i++) shape.lineTo(left[i * 2], left[i * 2 + 1]);
    for (let i = n - 1; i >= 0; i--) shape.lineTo(right[i * 2], right[i * 2 + 1]);
    shape.close();
  }
}

function toStop(color: RGB, alpha = 255): [number, number, number, number] {
  return [color[0], color[1], color[2], alpha];
}
