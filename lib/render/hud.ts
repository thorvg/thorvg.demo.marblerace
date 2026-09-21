/**
 * Race HUD, drawn in screen space: live standings, a mini map of the whole
 * course, the leader tag, event banners and the countdown.
 */

import type { LinearGradient, Scene, Shape, Text, ThorVGNamespace } from '@thorvg/webcanvas';
import { clamp, easeOutBack, easeOutCubic, lerp, span } from '../easing';
import { isLatin, type FontResolver } from '../fonts';
import { UI, lighten, mix } from '../palette';
import type { Marble, Phase, RGB } from '../types';
import { ColorPool, type Viewport } from './common';

const ROWS = 5;

export interface Banner {
  text: string;
  sub: string;
  color: RGB;
  /** Seconds since the banner was raised. */
  t: number;
}

export interface HudState {
  phase: Phase;
  time: number;
  viewport: Viewport;
  standings: readonly Marble[];
  /** Set when the reveal is showing its own results board. */
  hideStandings?: boolean;
  leader: Marble | null;
  finishY: number;
  countdown: number | null;
  /** Label for the final beat of the countdown. */
  countdownGo: string;
  banner: Banner | null;
  hint: string | null;
  hideTag: boolean;
  followIndex: number;
  /** Picks the face that can actually draw a given name. */
  fontFor: FontResolver;
  project: (x: number, y: number) => { x: number; y: number };
}

interface Row {
  plate: Shape;
  dot: Shape;
  place: Text;
  name: Text;
  /** Animated screen y, so a change of position slides instead of jumping. */
  y: number;
  seeded: boolean;
  lastName: string;
  lastFont: string;
  lastPlace: string;
}

export class HudLayer {
  #tvg: ThorVGNamespace;
  #streaks: Shape;
  #rows: Row[] = [];
  #rail: Shape;
  #railFlag: Shape;
  #dots: ColorPool;
  #progressTrack: Shape;
  #progressFill: Shape;
  #tagPlate: Shape;
  #tagText: Text;
  #bannerPlate: Shape;
  #bannerDots: Shape;
  #bannerEdge: Shape;
  #bannerEdgeFill: LinearGradient;
  #bannerMarquee: Shape;
  #bannerGlow: Shape;
  /** One paint per character, so the call out can march in letter by letter. */
  #bannerLetters: Text[] = [];
  #bannerSub: Text;
  #count: Text;
  #hint: Text;
  #font: string;
  #bannerScene: Scene;

  constructor(tvg: ThorVGNamespace, scene: Scene, font: string) {
    this.#font = font;
    this.#tvg = tvg;
    this.#bannerScene = scene;

    this.#streaks = new tvg.Shape();
    scene.add(this.#streaks);

    this.#progressTrack = new tvg.Shape();
    scene.add(this.#progressTrack);
    this.#progressFill = new tvg.Shape();
    scene.add(this.#progressFill);

    for (let i = 0; i < ROWS; i++) {
      const plate = new tvg.Shape();
      const dot = new tvg.Shape();
      const place = new tvg.Text();
      const name = new tvg.Text();
      place.font(font).align(0.5, 0.5).fill(UI.textDim[0], UI.textDim[1], UI.textDim[2]);
      name.font(font).align(0, 0.5).fill(UI.text[0], UI.text[1], UI.text[2]);
      scene.add(plate);
      scene.add(dot);
      scene.add(place);
      scene.add(name);
      this.#rows.push({ plate, dot, place, name, y: 0, seeded: false, lastName: '', lastFont: '', lastPlace: '' });
    }

    this.#rail = new tvg.Shape();
    scene.add(this.#rail);
    this.#railFlag = new tvg.Shape();
    scene.add(this.#railFlag);
    this.#dots = new ColorPool(tvg, scene);

    this.#tagPlate = new tvg.Shape();
    scene.add(this.#tagPlate);
    this.#tagText = new tvg.Text();
    this.#tagText.font(font).align(0.5, 0.5);
    scene.add(this.#tagText);

    this.#bannerGlow = new tvg.Shape();
    scene.add(this.#bannerGlow);
    this.#bannerPlate = new tvg.Shape();
    scene.add(this.#bannerPlate);
    this.#bannerDots = new tvg.Shape();
    scene.add(this.#bannerDots);
    this.#bannerEdge = new tvg.Shape();
    this.#bannerEdgeFill = new tvg.LinearGradient(0, 0, 1, 0);
    scene.add(this.#bannerEdge);
    this.#bannerMarquee = new tvg.Shape();
    scene.add(this.#bannerMarquee);

    this.#bannerSub = new tvg.Text();
    this.#bannerSub.font(font).align(0.5, 0.5).fill(UI.textDim[0], UI.textDim[1], UI.textDim[2]);
    scene.add(this.#bannerSub);

    this.#count = new tvg.Text();
    this.#count.font(font).align(0.5, 0.5).fill(UI.text[0], UI.text[1], UI.text[2]);
    scene.add(this.#count);

    this.#hint = new tvg.Text();
    this.#hint.font(font).align(0.5, 0.5).fill(UI.textDim[0], UI.textDim[1], UI.textDim[2]);
    scene.add(this.#hint);

    this.#clear();
  }

  #clear(): void {
    this.#streaks.reset();
    this.#progressTrack.reset();
    this.#progressFill.reset();
    this.#rail.reset();
    this.#railFlag.reset();
    this.#tagPlate.reset();
    this.#bannerPlate.reset();
    this.#bannerDots.reset();
    this.#bannerEdge.reset();
    this.#bannerMarquee.reset();
    this.#bannerGlow.reset();
    for (const letter of this.#bannerLetters) letter?.opacity(0);
    for (const row of this.#rows) {
      row.plate.reset();
      row.dot.reset();
      row.place.opacity(0);
      row.name.opacity(0);
    }
    this.#tagText.opacity(0);
    this.#bannerSub.opacity(0);
    this.#count.opacity(0);
    this.#hint.opacity(0);
  }

  update(state: HudState, dt: number): void {
    const { viewport } = state;
    const ui = clamp(Math.min(viewport.width, viewport.height * 0.72) / 560, 0.78, 1.7);
    const racing = state.phase === 'racing' || state.phase === 'reveal';

    this.#clear();
    this.#drawHint(state, ui);
    this.#drawCountdown(state, ui);

    if (racing) {
      this.#drawSpeedLines(state);
      this.#drawProgress(state, ui);
      // The results board says the same thing, and says it better.
      if (!state.hideStandings) {
        this.#drawStandings(state, ui, dt);
        this.#drawMiniMap(state, ui);
      }
      if (state.phase === 'racing' && !state.hideTag) this.#drawLeaderTag(state, ui);
    } else {
      this.#dots.begin();
      this.#dots.finish();
    }

    this.#drawBanner(state, ui);
  }

  #drawHint(state: HudState, ui: number): void {
    if (!state.hint) return;
    const { viewport } = state;
    this.#hint
      .font(state.fontFor(state.hint))
      .text(state.hint)
      .fontSize(15 * ui)
      .opacity(190)
      .translate(viewport.width / 2, viewport.height - 30 * ui);
  }

  /** Edge streaks that pick up as the leader gets quicker. */
  #drawSpeedLines(state: HudState): void {
    const leader = state.leader;
    if (!leader || leader.finished) return;

    const speed = Math.hypot(leader.vx, leader.vy);
    const intensity = clamp((speed - 420) / 520, 0, 1);
    if (intensity < 0.03) return;

    const { width, height } = state.viewport;
    for (let i = 0; i < 16; i++) {
      const noise = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const near = width * 0.16 * noise + 6;
      const x = i % 2 === 0 ? near : width - near;
      const length = (70 + noise * 110) * (0.5 + intensity);
      const travel = (state.time * (760 + noise * 520) + i * 137) % (height + length * 2);
      this.#streaks.appendRect(x, travel - length, 2, length, { rx: 1, ry: 1 });
    }
    this.#streaks.fill(205, 225, 255, Math.round(intensity * 55));
  }

  #drawProgress(state: HudState, ui: number): void {
    const { viewport, leader, finishY } = state;
    if (!leader) return;

    const done = clamp(leader.best / finishY, 0, 1);
    const pad = 14 * ui;
    const width = viewport.width - pad * 2;
    const y = 8 * ui;

    this.#progressTrack.appendRect(pad, y, width, 4 * ui, { rx: 2 * ui, ry: 2 * ui }).fill(120, 150, 230, 45);

    // Animated gradient: a highlight runs along the filled part of the bar.
    const filled = Math.max(4, width * done);
    const lit = lighten(leader.color, 0.45);
    const base = leader.color;
    const sweep = (state.time * 0.4) % 1;
    const gradient = new this.#tvg.LinearGradient(pad, y, pad + filled, y);
    gradient.setStops(
      [0, [base[0], base[1], base[2], 235]],
      [Math.max(0.001, sweep * 0.98), [lit[0], lit[1], lit[2], 255]],
      [1, [base[0], base[1], base[2], 235]],
    );
    this.#progressFill.appendRect(pad, y, filled, 4 * ui, { rx: 2 * ui, ry: 2 * ui }).fill(gradient);
  }

  #drawStandings(state: HudState, ui: number, dt: number): void {
    const rowH = 30 * ui;
    const left = 14 * ui;
    const shown = Math.min(ROWS, state.standings.length);
    const top = state.viewport.height - 22 * ui - shown * rowH;
    const width = 176 * ui;

    for (let i = 0; i < this.#rows.length; i++) {
      const row = this.#rows[i];
      const marble = state.standings[i];
      if (!marble) continue;

      const targetY = top + i * rowH;
      row.y = row.seeded ? lerp(row.y, targetY, 1 - Math.exp(-14 * dt)) : targetY;
      row.seeded = true;

      const y = row.y;
      const lead = i === 0;
      const ridden = marble.index === state.followIndex;
      const color = marble.color;

      row.plate
        .appendRect(left, y, width, rowH - 6 * ui, { rx: 9 * ui, ry: 9 * ui })
        .fill(9, 14, 32, lead || ridden ? 205 : 150)
        .stroke({
          width: ridden ? 1.6 : 1,
          color: lead || ridden ? [color[0], color[1], color[2], ridden ? 235 : 190] : [120, 150, 230, 45],
        });

      row.dot.appendCircle(left + 30 * ui, y + (rowH - 6 * ui) / 2, 5.5 * ui).fill(color[0], color[1], color[2], 255);

      const place = marble.finished ? `${i + 1}` : `${i + 1}`;
      if (row.lastPlace !== place) {
        row.place.text(place);
        row.lastPlace = place;
      }
      // The face can change after the CJK font finishes loading.
      const face = state.fontFor(marble.name);
      if (row.lastName !== marble.name || row.lastFont !== face) {
        row.name.font(face).text(marble.name);
        row.lastName = marble.name;
        row.lastFont = face;
      }

      row.place
        .fontSize(13 * ui)
        .fill(lead ? 255 : UI.textDim[0], lead ? 214 : UI.textDim[1], lead ? 107 : UI.textDim[2])
        .opacity(255)
        .translate(left + 14 * ui, y + (rowH - 6 * ui) / 2);

      row.name
        .fontSize(14 * ui)
        .opacity(lead ? 255 : 205)
        .translate(left + 44 * ui, y + (rowH - 6 * ui) / 2);
    }
  }

  #drawMiniMap(state: HudState, ui: number): void {
    const { viewport, standings, finishY } = state;
    const x = viewport.width - 20 * ui;
    const top = 46 * ui;
    const bottom = viewport.height - 46 * ui;

    this.#rail
      .appendRect(x - 2 * ui, top, 4 * ui, bottom - top, { rx: 2 * ui, ry: 2 * ui })
      .fill(120, 150, 230, 40);

    this.#railFlag
      .appendRect(x - 7 * ui, bottom - 3 * ui, 14 * ui, 6 * ui, { rx: 2 * ui, ry: 2 * ui })
      .fill(UI.gold[0], UI.gold[1], UI.gold[2], 220);

    this.#dots.begin();
    for (let i = standings.length - 1; i >= 0; i--) {
      const marble = standings[i];
      const progress = clamp(marble.best / finishY, 0, 1);
      const y = lerp(top, bottom, progress);
      const lead = i === 0;
      const shape = this.#dots.shape(marble.color, lead ? 255 : 190);
      shape.appendCircle(x, y, (lead ? 5.5 : 4) * ui);
    }
    this.#dots.finish();
  }

  #drawLeaderTag(state: HudState, ui: number): void {
    const { leader } = state;
    if (!leader || leader.finished) return;

    const at = state.project(leader.x, leader.y);
    const width = Math.max(56, leader.name.length * 8.6 + 22) * ui;
    const height = 22 * ui;
    const x = clamp(at.x, width / 2 + 8, state.viewport.width - width / 2 - 8);
    const y = clamp(at.y - 42 * ui, height, state.viewport.height - height);
    const color = leader.color;

    this.#tagPlate
      .appendRect(x - width / 2, y - height / 2, width, height, { rx: height / 2, ry: height / 2 })
      .fill(8, 12, 28, 205)
      .stroke({ width: 1.2, color: [color[0], color[1], color[2], 220] });

    // Little pointer towards the marble.
    this.#tagPlate
      .moveTo(x - 5 * ui, y + height / 2 - 1)
      .lineTo(x + 5 * ui, y + height / 2 - 1)
      .lineTo(x, y + height / 2 + 6 * ui)
      .close();

    const bright = lighten(color, 0.45);
    this.#tagText
      .font(state.fontFor(leader.name))
      .text(leader.name)
      .fontSize(12.5 * ui)
      .fill(bright[0], bright[1], bright[2])
      .opacity(255)
      .translate(x, y);
  }

  #drawCountdown(state: HudState, ui: number): void {
    if (state.countdown === null) return;

    const { viewport } = state;
    const remaining = state.countdown;
    const step = Math.ceil(remaining);
    const u = clamp(1 - (remaining - (step - 1)), 0, 1);
    const label = step <= 0 ? state.countdownGo : String(step);

    const grow = 1.35 - 0.35 * easeOutCubic(clamp(u * 2.4, 0, 1));
    const fade = 1 - easeOutCubic(clamp((u - 0.55) / 0.45, 0, 1));

    this.#count
      .font(state.fontFor(label))
      .text(label)
      .fontSize(120 * ui * grow)
      .opacity(Math.round(fade * 240))
      .translate(viewport.width / 2, viewport.height * 0.42);
  }

  /**
   * Race board call out: an LED style panel with a running light border, a
   * gradient edge and the headline marching in one character at a time.
   */
  #drawBanner(state: HudState, ui: number): void {
    const banner = state.banner;
    if (!banner) return;

    const t = banner.t;
    const inCurve = easeOutBack(span(t, 0, 0.42));
    // At the finish the call out is a quick flash: the hero orb takes over.
    const out = state.phase === 'reveal' ? span(t, 0.5, 0.95) : span(t, 1.5, 2.1);
    if (out >= 1) return;

    const fade = (1 - out) * clamp(t / 0.14, 0, 1);
    const alpha = fade * 255;
    // During the reveal the hero orb owns the middle, so callouts sit higher.
    const anchor = state.phase === 'reveal' ? 0.09 : 0.19;
    const midX = state.viewport.width / 2;
    const y = state.viewport.height * anchor + (1 - inCurve) * 22 * ui;
    const size = clamp(25 * ui, 15, 58);

    const chars = Array.from(banner.text);
    const latin = isLatin(banner.text);
    // Fixed cells, the way a real dot matrix board lays out its glyphs.
    const cell = size * (latin ? 0.76 : 1.06);
    // Spaces get a narrower cell, otherwise word gaps read as missing letters.
    const advance = (ch: string) => (ch === ' ' ? cell * 0.55 : cell);
    const textW = chars.reduce((sum, ch) => sum + advance(ch), 0);
    const subW = banner.sub.length * size * (isLatin(banner.sub) ? 0.29 : 0.46);
    const plateW = Math.max(textW, subW) + size * 1.9;
    const plateH = size * (banner.sub ? 2.9 : 1.95);
    const left = midX - plateW / 2;
    const top = y - size * 1.08;
    const radius = size * 0.42;
    const color = banner.color;

    // Ambient spill so the panel sits on the track rather than floating.
    this.#bannerGlow
      .appendRect(left - size * 0.3, top - size * 0.3, plateW + size * 0.6, plateH + size * 0.6, {
        rx: radius + size * 0.3,
        ry: radius + size * 0.3,
      })
      .fill(color[0], color[1], color[2], Math.round(fade * 26));

    this.#bannerPlate
      .appendRect(left, top, plateW, plateH, { rx: radius, ry: radius })
      .fill(6, 8, 14, Math.round(fade * 232))
      .stroke({ width: 1, color: [color[0], color[1], color[2], Math.round(fade * 90)] });

    this.#drawLedTexture(left, top, plateW, plateH, size, fade, color);

    // Gradient edge along the top of the panel.
    this.#bannerEdgeFill = new this.#tvg.LinearGradient(left, 0, left + plateW, 0);
    const warm = lighten(color, 0.45);
    this.#bannerEdgeFill.setStops(
      [0, [color[0], color[1], color[2], 0]],
      [0.5, [warm[0], warm[1], warm[2], Math.round(fade * 235)]],
      [1, [color[0], color[1], color[2], 0]],
    );
    this.#bannerEdge
      .appendRect(left + radius * 0.6, top, plateW - radius * 1.2, Math.max(1.5, size * 0.055), {
        rx: 1,
        ry: 1,
      })
      .fill(this.#bannerEdgeFill);

    // Running lights around the frame.
    const dash = size * 0.42;
    this.#bannerMarquee
      .appendRect(left + 2, top + 2, plateW - 4, plateH - 4, { rx: radius - 2, ry: radius - 2 })
      .stroke({
        width: Math.max(1.2, size * 0.055),
        color: [color[0], color[1], color[2], Math.round(fade * 150)],
        dash: [dash, dash * 1.3],
        dashOffset: -t * size * 7,
      });

    this.#drawBannerText(state, chars, latin, midX - textW / 2, y, advance, size, t, fade, color);

    if (!banner.sub) return;
    const subFade = fade * clamp(span(t, 0.28, 0.6), 0, 1);
    this.#bannerSub
      .font(state.fontFor(banner.sub))
      .text(banner.sub)
      .fontSize(size * 0.44)
      .fill(UI.textDim[0], UI.textDim[1], UI.textDim[2])
      .opacity(Math.round(subFade * 235))
      .translate(midX, y + size * 1.0);
  }

  /** The dot grid that makes the panel read as an LED board. */
  #drawLedTexture(
    left: number,
    top: number,
    width: number,
    height: number,
    size: number,
    fade: number,
    color: RGB,
  ): void {
    const pitch = Math.max(7, size * 0.34);
    const inset = size * 0.34;
    const radius = Math.max(0.7, pitch * 0.13);

    for (let y = top + inset; y < top + height - inset * 0.6; y += pitch) {
      for (let x = left + inset; x < left + width - inset * 0.6; x += pitch) {
        this.#bannerDots.appendCircle(x, y, radius);
      }
    }
    this.#bannerDots.fill(color[0], color[1], color[2], Math.round(fade * 34));
  }

  /**
   * Characters land one after another, then a highlight chases along the line
   * the way a stadium board sweeps its message.
   */
  #drawBannerText(
    state: HudState,
    chars: readonly string[],
    latin: boolean,
    startX: number,
    y: number,
    advance: (ch: string) => number,
    size: number,
    t: number,
    fade: number,
    color: RGB,
  ): void {
    const hot = lighten(color, 0.72);
    let x = startX;

    for (let i = 0; i < chars.length; i++) {
      const width = advance(chars[i]);
      const centre = x + width / 2;
      x += width;

      // A paint is kept for every index, spaces included, so the pool never
      // ends up with holes.
      const letter = this.#letter(i, state.fontFor(chars[i]));
      if (chars[i] === ' ') {
        letter.opacity(0);
        continue;
      }

      const delay = i * 0.035;
      const land = easeOutBack(span(t, delay, delay + 0.34));
      if (land <= 0.001) {
        letter.opacity(0);
        continue;
      }

      // Highlight sweep, restarted once while the banner is up.
      const wave = Math.sin((t - 0.2) * 5.4 - i * 0.5);
      const lit = Math.max(0, wave) ** 2;
      const tone = mix(color, hot, lit);

      letter
        .text(chars[i])
        .fontSize(size * (0.82 + land * 0.18) * (1 + lit * 0.07))
        .fill(tone[0], tone[1], tone[2])
        .opacity(Math.round(fade * clamp(land, 0, 1) * 255))
        .translate(centre, y + (1 - land) * size * 0.45);

      if (!latin) letter.spacing(1, 1);
    }
  }

  /** Lazily grown pool of one paint per character. */
  #letter(index: number, font: string): Text {
    let letter = this.#bannerLetters[index];
    if (!letter) {
      letter = new this.#tvg.Text();
      letter.align(0.5, 0.5);
      this.#bannerScene.add(letter);
      this.#bannerLetters[index] = letter;
    }
    letter.font(font);
    return letter;
  }

  get font(): string {
    return this.#font;
  }
}
