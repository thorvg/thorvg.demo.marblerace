/**
 * Winner reveal. A single timeline drives the dim, the flight of the winning
 * marble into a hero orb, the ring that draws itself around it and the name.
 */

import type { Animation, Picture, RadialGradient, Scene, Shape, Text, ThorVGNamespace } from '@thorvg/webcanvas';

import { UI, darken, lighten } from '../palette';
import { clamp, easeOutBack, easeOutCubic, easeOutQuint, lerp, pulse, span } from '../easing';
import { glyphDrop, isLatin, type FontResolver } from '../fonts';
import { skinPayload, type Skin } from '../skins';
import { addCircleFromTop } from './common';
import type { Marble, RankEntry, RGB, Vec2 } from '../types';

/** The reveal is laid out in this box and letterboxed onto the canvas. */
const WORLD = { width: 760, height: 1120 } as const;

const ORB = { x: WORLD.width / 2, y: 404, r: 92 };
const RING_R = 128;
const UNIT = 100;

/** Placings the board has room for; MAX_NAMES runners at most. */
const MAX_ROWS = 20;
/** The band under the hero block the results board is laid out in. */
const BOARD = { top: 828, bottom: 1086, pad: 56 } as const;

export const REVEAL_MARKS = {
  wave: [0, 0.14, 0.3],
  confetti: 0.95,
  sparkleFrom: 1.0,
  sparkleTo: 3.4,
  done: 2.1,
} as const;

export class RevealLayer {
  #tvg: ThorVGNamespace;
  #dim: Shape;
  #flash: Shape;
  #orbGlow: Shape;
  #orbGlowFill: RadialGradient;
  #orb: Shape;
  #orbFill: RadialGradient;
  #orbLabel: Text;
  #orbLabelLift = 0;
  #clipper: Shape;
  #clipperAnim: Shape;
  #picture: Picture;
  #animation: Animation;
  #gloss: Shape;
  #skin: 'none' | 'picture' | 'animation' = 'none';
  #frames = 0;
  #fps = 30;
  #ring: Shape;
  #dashRing: Shape;
  #label: Text;
  #name: Text;
  #line: Shape;
  /** One plate, name and time per placing, built once and reused. */
  #rows: { plate: Shape; place: Text; name: Text; time: Text }[] = [];
  #ranking: RankEntry[] = [];
  #nameSize = 74;
  #labelText = 'WINNER';
  #color: RGB = [255, 255, 255];
  #from: Vec2 = { x: ORB.x, y: 1040 };
  #fromR = 14;

  constructor(tvg: ThorVGNamespace, dimScene: Scene, scene: Scene, latinFont: string) {
    this.#tvg = tvg;
    const over = 700;

    this.#dim = new tvg.Shape();
    this.#dim.appendRect(-over, -over, WORLD.width + over * 2, WORLD.height + over * 2).fill(4, 6, 16, 255);
    dimScene.add(this.#dim);

    this.#flash = new tvg.Shape();
    this.#flash
      .appendRect(-over, -over, WORLD.width + over * 2, WORLD.height + over * 2)
      .fill(255, 255, 255, 255)
      .blend(tvg.BlendMethod.Add);
    dimScene.add(this.#flash);

    this.#orbGlow = new tvg.Shape();
    this.#orbGlowFill = new tvg.RadialGradient(0, 0, UNIT);
    this.#orbGlow.appendCircle(0, 0, UNIT).fill(this.#orbGlowFill);
    // Blended as a scene: GL faults on a blended gradient shape.
    const glowScene = new tvg.Scene();
    glowScene.blend(tvg.BlendMethod.Add);
    glowScene.add(this.#orbGlow);
    scene.add(glowScene);

    this.#ring = new tvg.Shape();
    scene.add(this.#ring);

    this.#dashRing = new tvg.Shape();
    scene.add(this.#dashRing);

    this.#orb = new tvg.Shape();
    this.#orbFill = new tvg.RadialGradient(0, 0, UNIT, -UNIT * 0.34, -UNIT * 0.4, 0);
    this.#orb.appendCircle(0, 0, UNIT).fill(this.#orbFill);
    scene.add(this.#orb);

    // Skin artwork for the hero orb, clipped into the same circle.
    this.#clipper = new tvg.Shape();
    this.#picture = new tvg.Picture();
    this.#picture.clip(this.#clipper);
    scene.add(this.#picture);

    // A clipper binds to a single paint, so the lottie gets its own.
    this.#clipperAnim = new tvg.Shape();
    this.#animation = new tvg.Animation();
    const animPicture = this.#animation.picture;
    if (animPicture) {
      animPicture.clip(this.#clipperAnim);
      scene.add(animPicture);
    }

    this.#gloss = new tvg.Shape();
    const glossFill = new tvg.RadialGradient(0, 0, UNIT, -UNIT * 0.36, -UNIT * 0.42, 0);
    glossFill.setStops(
      [0, [255, 255, 255, 150]],
      [0.3, [255, 255, 255, 26]],
      [0.72, [0, 0, 0, 0]],
      [1, [0, 0, 0, 150]],
    );
    this.#gloss.appendCircle(0, 0, UNIT).fill(glossFill);
    scene.add(this.#gloss);

    this.#orbLabel = new tvg.Text();
    this.#orbLabel.align(0.5, 0.5);
    scene.add(this.#orbLabel);

    this.#label = new tvg.Text();
    this.#label.font(latinFont).text(this.#labelText).fontSize(26).spacing(1.5, 1).align(0.5, 0.5);
    scene.add(this.#label);

    // The finishing order, shown under the hero block on a ranking run.
    for (let i = 0; i < MAX_ROWS; i++) {
      const plate = new tvg.Shape();
      scene.add(plate);
      // The columns run top to bottom, so each row states its own placing.
      const place = new tvg.Text();
      place.font(latinFont).align(1, 0.5);
      scene.add(place);
      const name = new tvg.Text();
      name.font(latinFont).align(0, 0.5);
      scene.add(name);
      const time = new tvg.Text();
      time.font(latinFont).align(1, 0.5);
      scene.add(time);
      this.#rows.push({ plate, place, name, time });
    }

    this.#name = new tvg.Text();
    this.#name.align(0.5, 0.5);
    scene.add(this.#name);

    this.#line = new tvg.Shape();
    scene.add(this.#line);

    this.hide();
  }

  /** The caption above the winner's name. */
  setLabel(text: string): void {
    this.#labelText = text;
  }

  /** Everything is dismissed with zero opacity or an empty path. */
  hide(): void {
    this.#dim.opacity(0);
    this.#flash.opacity(0);
    this.#orbGlow.opacity(0);
    this.#orb.opacity(0);
    this.#orbLabel.opacity(0);
    this.#gloss.opacity(0);
    this.#picture.opacity(0);
    this.#animation.picture?.opacity(0);
    this.#label.opacity(0);
    for (const row of this.#rows) {
      row.plate.reset();
      row.place.opacity(0);
      row.name.opacity(0);
      row.time.opacity(0);
    }
    this.#name.opacity(0);
    this.#ring.reset();
    this.#dashRing.reset();
    this.#line.reset();
  }

  /** Locks in the winner's colours, text and flight origin. */
  configure(
    winner: Marble,
    from: Vec2,
    fromRadius: number,
    fontFor: FontResolver,
    skin?: Skin,
    ranking: RankEntry[] = [],
  ): void {
    const color = winner.color;
    this.#color = color;
    this.#from = { x: from.x, y: from.y };
    this.#fromR = fromRadius;

    this.#orbFill.setStops(
      [0, stop(lighten(color, 0.72))],
      [0.34, stop(lighten(color, 0.14))],
      [0.82, stop(color)],
      [1, stop(darken(color, 0.34))],
    );
    this.#orb.fill(this.#orbFill);
    this.#orb.stroke({ width: 8, color: [...stop(darken(color, 0.5), 230)] });

    this.#orbGlowFill.setStops(
      [0, stop(lighten(color, 0.35), 255)],
      [0.35, stop(color, 130)],
      [0.7, stop(color, 36)],
      [1, stop(color, 0)],
    );
    this.#orbGlow.fill(this.#orbGlowFill);

    this.#skin = 'none';
    this.#frames = 0;
    const payload = skin ? skinPayload(skin) : null;
    if (skin && payload) {
      if (skin.type === 'lot') {
        this.#animation.load(payload as string);
        const info = this.#animation.info();
        this.#frames = info?.totalFrames ?? 0;
        this.#fps = info?.fps || 30;
        this.#skin = 'animation';
      } else {
        this.#picture.load(payload, { type: skin.type });
        this.#skin = 'picture';
      }
    }

    const initial = Array.from(winner.name.trim())[0] ?? '?';
    const ink = darken(color, 0.5);
    const font = fontFor(initial);
    this.#orbLabelLift = glyphDrop(font, initial) * 0.9;
    this.#orbLabel.font(font).text(initial).fontSize(ORB.r * 0.9).fill(ink[0], ink[1], ink[2]);

    // Wide tracking suits latin caps, Hangul needs far less.
    this.#label
      .font(fontFor(this.#labelText))
      .text(this.#labelText)
      .spacing(isLatin(this.#labelText) ? 1.5 : 1.14, 1);
    this.#nameSize = fitFontSize(winner.name, 88, WORLD.width - 160);
    const bright = lighten(color, 0.42);
    this.#name.font(fontFor(winner.name)).text(winner.name).fill(bright[0], bright[1], bright[2]);
    this.#label.fill(UI.textDim[0], UI.textDim[1], UI.textDim[2]);

    // A single placing is just the winner, which the hero block already says.
    this.#ranking = ranking.length > 1 ? ranking.slice(0, MAX_ROWS) : [];
    for (let i = 0; i < this.#rows.length; i++) {
      const row = this.#rows[i];
      const entry = this.#ranking[i];
      if (!entry) {
        row.plate.reset();
        row.place.opacity(0);
        row.name.opacity(0);
        row.time.opacity(0);
        continue;
      }
      row.place
        .font(fontFor('0'))
        .text(String(entry.place))
        .fill(UI.textDim[0], UI.textDim[1], UI.textDim[2]);
      const ink = i === 0 ? lighten(entry.color, 0.5) : UI.text;
      row.name
        .font(fontFor(entry.name))
        .text(entry.name)
        .fill(ink[0], ink[1], ink[2]);
      row.time
        .font(fontFor('0'))
        .text(entry.elapsed === null ? '—' : `${entry.elapsed.toFixed(2)}s`)
        .fill(UI.textDim[0], UI.textDim[1], UI.textDim[2]);
    }
  }

  /**
   * The finishing order, under the hero block. One column up to six runners,
   * two beyond that, with the row height taken from whatever space is left.
   */
  #drawBoard(t: number): void {
    const count = this.#ranking.length;
    if (!count) return;

    const cols = count > 6 ? 2 : 1;
    const perCol = Math.ceil(count / cols);
    const rowH = clamp((BOARD.bottom - BOARD.top) / perCol, 17, 34);
    // A short list reads better narrow and centred than stretched edge to edge.
    const spread = cols === 1 ? Math.min(WORLD.width - BOARD.pad * 2, 430) : WORLD.width - BOARD.pad * 2;
    const colW = spread / cols;
    const originX = (WORLD.width - spread) / 2;
    const fontSize = Math.min(21, rowH * 0.56);

    for (let i = 0; i < count; i++) {
      const entry = this.#ranking[i];
      const row = this.#rows[i];
      // Rows arrive one after another, so the board reads as it fills in.
      const fade = easeOutCubic(span(t, 1.95 + i * 0.045, 2.3 + i * 0.045));
      const alpha = Math.round(fade * 255);

      const col = Math.floor(i / perCol);
      const line = i % perCol;
      const left = originX + col * colW;
      const y = BOARD.top + rowH * (line + 0.5) + (1 - fade) * 10;

      row.plate.reset();
      if (fade > 0.001) {
        const dotR = Math.min(7, rowH * 0.22);
        row.plate.appendCircle(left + 32 + dotR, y, dotR).fill(...stop(entry.color, alpha));
      }

      row.place
        .fontSize(fontSize * 0.82)
        .opacity(Math.round(fade * 150))
        .translate(left + 18, y);
      row.name
        .fontSize(fontSize)
        .opacity(alpha)
        .translate(left + 52, y);
      row.time
        .fontSize(fontSize * 0.86)
        .opacity(Math.round(fade * 170))
        .translate(left + colW - 22, y);
    }
  }

  /** @param t seconds since the winner crossed the goal */
  update(t: number): void {
    const color = this.#color;

    // Impact flash.
    const flash = pulse(span(t, 0, 0.28));
    this.#flash.opacity(Math.round(flash * 165));

    // Dim the playfield.
    const dim = easeOutCubic(span(t, 0.1, 0.85));
    this.#dim.opacity(Math.round(dim * 214));

    // Flight of the winning marble into the hero orb.
    const flight = easeOutCubic(span(t, 0.3, 1.1));
    const x = lerp(this.#from.x, ORB.x, flight);
    const y = lerp(this.#from.y, ORB.y, flight) - Math.sin(flight * Math.PI) * 130;
    const radius = lerp(this.#fromR, ORB.r, easeOutQuint(span(t, 0.3, 1.15)));
    const breathe = 1 + Math.sin(Math.max(0, t - 1.2) * 2.4) * 0.018;

    const skinned = this.#skin !== 'none';
    this.#orb.opacity(skinned ? 0 : 255).scale((radius / UNIT) * breathe).translate(x, y);

    if (skinned) {
      const size = radius * breathe * 2;
      const clipper = this.#skin === 'animation' ? this.#clipperAnim : this.#clipper;
      clipper.reset();
      clipper.appendCircle(x, y, radius * breathe).fill(255, 255, 255, 255);
      this.#gloss.opacity(255).scale((radius / UNIT) * breathe).translate(x, y);

      const artwork = this.#skin === 'animation' ? this.#animation.picture : this.#picture;
      artwork?.opacity(255).size(size, size).translate(x - size / 2, y - size / 2);
      if (this.#skin === 'animation' && this.#frames > 1) {
        this.#animation.frame((t * this.#fps) % this.#frames);
      }
    } else {
      this.#gloss.opacity(0);
      this.#picture.opacity(0);
      this.#animation.picture?.opacity(0);
    }
    this.#orbGlow
      .opacity(255)
      .scale(((radius * 2.2) / UNIT) * breathe)
      .translate(x, y);

    const labelIn = span(t, 1.0, 1.35);
    this.#orbLabel
      .fontSize(ORB.r * 0.9 * (radius / ORB.r))
      .opacity(this.#skin === 'none' ? Math.round(labelIn * 115) : 0)
      .translate(x, y - this.#orbLabelLift * radius);

    // Ring that draws itself, then a slow counter-rotating dashed ring.
    const trim = easeOutQuint(span(t, 1.0, 1.85));
    this.#ring.reset();
    if (trim > 0.001) {
      addCircleFromTop(this.#ring, ORB.x, ORB.y, RING_R);
      // Animated gradient: the sheen rotates around the ring.
      const a = t * 1.6;
      const sheen = new this.#tvg.LinearGradient(
        ORB.x + Math.cos(a) * RING_R,
        ORB.y + Math.sin(a) * RING_R,
        ORB.x - Math.cos(a) * RING_R,
        ORB.y - Math.sin(a) * RING_R,
      );
      const bright = lighten(color, 0.75);
      const deep = lighten(color, 0.1);
      sheen.setStops([0, stop(bright, 255)], [0.5, stop(deep, 210)], [1, stop(bright, 255)]);
      this.#ring.trimPath(0, trim).stroke({ width: 4, gradient: sheen });
    }

    const dash = span(t, 1.15, 1.7);
    this.#dashRing.reset();
    if (dash > 0.001) {
      this.#dashRing
        .appendCircle(0, 0, RING_R + 20)
        .stroke({
          width: 2,
          color: [...stop(UI.gold, Math.round(dash * 190))],
          dash: [4, 20],
        })
        .rotate(-t * 22)
        .translate(ORB.x, ORB.y);
    }

    // Caption block.
    const labelFade = easeOutCubic(span(t, 1.05, 1.45));
    this.#label
      .opacity(Math.round(labelFade * 235))
      .translate(ORB.x, 622 + (1 - labelFade) * 16);

    const nameGrow = easeOutBack(span(t, 1.18, 1.85));
    this.#name
      .fontSize(Math.max(1, this.#nameSize * nameGrow))
      .opacity(Math.round(clamp(span(t, 1.18, 1.42), 0, 1) * 255))
      .translate(ORB.x, 698);

    this.#drawBoard(t);

    const lineGrow = easeOutCubic(span(t, 1.5, 2.05));
    this.#line.reset();
    if (lineGrow > 0.001) {
      const half = 150 * lineGrow;
      this.#line
        .appendRect(ORB.x - half, 790, half * 2, 3, { rx: 1.5, ry: 1.5 })
        .fill(...stop(lighten(color, 0.2), Math.round(lineGrow * 190)));
    }
  }
}

function stop(color: RGB, alpha = 255): [number, number, number, number] {
  return [color[0], color[1], color[2], alpha];
}

/**
 * Rough advance width model for the display face, calibrated against rendered
 * text so long names scale down instead of running off the board.
 */
export function fitFontSize(text: string, base: number, maxWidth: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x1100) units += 1.05;
    else if (ch === ' ') units += 0.32;
    else if ('ijltfrIJ'.includes(ch)) units += 0.4;
    else if ('mwMW'.includes(ch)) units += 1;
    else if (ch >= 'A' && ch <= 'Z') units += 0.78;
    else if (ch >= '0' && ch <= '9') units += 0.66;
    else if (ch >= 'a' && ch <= 'z') units += 0.63;
    else units += 0.5;
  }
  if (units <= 0) return base;
  // Measured glyph advances run wider than the nominal widths above.
  return Math.min(base, maxWidth / (units * 1.4));
}
