/**
 * The board as it is being drawn.
 *
 * While the editor is open the baked course layers are hidden and everything —
 * rails, pegs, walls, machinery, boost pads, the finish — is rebuilt here from
 * the blueprint each frame. That is what makes a drag feel live: there is no
 * geometry to recompile between the pointer moving and the pixel changing.
 *
 * Machinery is drawn at its pose at course time zero rather than animated, so
 * what the pointer picks is exactly what the eye sees, and the reach of a
 * spinner or the swing of a pendulum is shown as a faint envelope instead.
 *
 * Everything is batched: one shape per colour role, not one per item, so a
 * thousand pegs still cost a handful of paints.
 */

import type { Scene, Shape, ThorVGNamespace } from '@thorvg/webcanvas';
import { COURSE } from '../board';
import {
  WALL_R,
  boundsOf,
  isHot,
  partsOf,
  restPose,
  type Box,
  type MapItem,
  type MovingItem,
} from '../blueprint';
import { HANDLE_SIZE, type EditorFrame } from '../mapEditor';
import { UI, darken, lighten } from '../palette';
import type { RGB } from '../types';
import { addCapsulePath } from './common';

const SELECT: RGB = [0, 224, 160];
const HOVER: RGB = [235, 242, 248];
const FINISH_MARK: RGB = [245, 192, 78];
const RELEASE: RGB = [0, 144, 216];

/** Below this many pixels a grid line is noise, so the fine grid drops out. */
const GRID_MIN_PX = 5;

export class EditorLayer {
  #shapes: Shape[] = [];
  #next = 0;
  #scene: Scene;
  #tvg: ThorVGNamespace;

  constructor(tvg: ThorVGNamespace, scene: Scene) {
    this.#tvg = tvg;
    this.#scene = scene;
  }

  /** Draw order is call order, so every frame asks for its shapes in sequence. */
  #shape(): Shape {
    let shape = this.#shapes[this.#next];
    if (!shape) {
      shape = new this.#tvg.Shape();
      this.#scene.add(shape);
      this.#shapes.push(shape);
    }
    this.#next++;
    shape.reset();
    return shape;
  }

  clear(): void {
    for (const shape of this.#shapes) shape.reset();
    this.#next = 0;
  }

  /**
   * @param scale canvas pixels per world unit, so chrome keeps a constant size
   * @param cameraY / viewHeight the visible band, used to cull
   */
  update(frame: EditorFrame, scale: number, cameraY: number, viewHeight: number): void {
    this.#next = 0;
    const top = cameraY - viewHeight * 0.6;
    const bottom = cameraY + viewHeight * 0.6;
    const px = 1 / Math.max(scale, 0.0001);

    this.#drawGrid(frame, px, top, bottom);
    this.#drawBoard(frame, px, top, bottom);
    this.#drawItems(frame, px, top, bottom);
    this.#drawChrome(frame, px, top, bottom);

    for (let i = this.#next; i < this.#shapes.length; i++) this.#shapes[i].reset();
  }

  /* ----------------------------------------------------------------- grid */

  #drawGrid(frame: EditorFrame, px: number, top: number, bottom: number): void {
    const minor = this.#shape();
    const major = this.#shape();
    if (frame.grid <= 0) return;

    const step = frame.grid;
    const fine = step / px >= GRID_MIN_PX;
    const y0 = Math.floor(top / step) * step;
    const y1 = Math.ceil(bottom / step) * step;
    const thin = px * 0.7;

    for (let x = COURSE.left; x <= COURSE.right + 0.5; x += step) {
      const heavy = Math.round((x - COURSE.left) / step) % 5 === 0;
      if (!heavy && !fine) continue;
      (heavy ? major : minor).appendRect(x - thin / 2, y0, thin, y1 - y0);
    }
    for (let y = y0; y <= y1; y += step) {
      const heavy = Math.round(y / step) % 5 === 0;
      if (!heavy && !fine) continue;
      (heavy ? major : minor).appendRect(COURSE.left, y - thin / 2, COURSE.right - COURSE.left, thin);
    }

    minor.fill(255, 255, 255, 12);
    major.fill(255, 255, 255, 26);
  }

  /* ---------------------------------------------------------------- board */

  #drawBoard(frame: EditorFrame, px: number, top: number, bottom: number): void {
    const rails = this.#shape();
    addCapsulePath(rails, COURSE.left, Math.max(40, top), COURSE.left, Math.min(frame.height - 40, bottom), 7);
    addCapsulePath(rails, COURSE.right, Math.max(40, top), COURSE.right, Math.min(frame.height - 40, bottom), 7);
    rails.fill(72, 84, 96, 255);

    // Release line: where the marbles are held before the drop.
    const release = this.#shape();
    if (COURSE.releaseY > top - 40 && COURSE.releaseY < bottom + 40) {
      release
        .appendRect(COURSE.left, COURSE.releaseY - px, COURSE.right - COURSE.left, px * 2)
        .fill(RELEASE[0], RELEASE[1], RELEASE[2], 150);
    }

    const finishY = frame.finishY;
    const bed = this.#shape();
    const line = this.#shape();
    const goal = this.#shape();
    if (finishY > top - 300 && finishY < bottom + 300) {
      bed.appendRect(COURSE.left, finishY - 6, COURSE.right - COURSE.left, 44, { rx: 8, ry: 8 });
      bed.fill(10, 16, 36, 200);

      // Chequered strip, the same two rows the race board carries.
      const cell = 22;
      for (let i = 0; i * cell < COURSE.right - COURSE.left; i++) {
        for (let row = 0; row < 2; row++) {
          if ((i + row) % 2 !== 0) continue;
          const x = COURSE.left + i * cell;
          line.appendRect(x, finishY + row * 16, Math.min(cell, COURSE.right - x), 16);
        }
      }
      line.fill(UI.finish[0], UI.finish[1], UI.finish[2], 190);

      goal
        .appendCircle(COURSE.width / 2, finishY + 96, 58)
        .stroke({ width: px * 2, color: [UI.goal[0], UI.goal[1], UI.goal[2], 150], dash: [px * 8, px * 6] });
    }
  }

  /* ---------------------------------------------------------------- items */

  #drawItems(frame: EditorFrame, px: number, top: number, bottom: number): void {
    const decalEdge = this.#shape();
    const boostBody = this.#shape();
    const boostArrow = this.#shape();
    const wallBody = this.#shape();
    const wallCore = this.#shape();
    const range = this.#shape();
    const machineShell = this.#shape();
    const machineBody = this.#shape();
    const machineLight = this.#shape();
    const hotShell = this.#shape();
    const hotBody = this.#shape();
    const hotLight = this.#shape();
    const pegBody = this.#shape();
    const pegShine = this.#shape();
    const bumperBody = this.#shape();
    const bumperShine = this.#shape();

    for (const item of frame.items) {
      const box = boundsOf(item);
      if (box.y1 < top || box.y0 > bottom) continue;

      switch (item.kind) {
        case 'peg': {
          const body = item.bumper ? bumperBody : pegBody;
          const shine = item.bumper ? bumperShine : pegShine;
          body.appendCircle(item.x, item.y, item.r);
          shine.appendCircle(item.x - item.r * 0.23, item.y - item.r * 0.29, item.r * 0.6);
          break;
        }
        case 'wall':
          addCapsulePath(wallBody, item.x1, item.y1, item.x2, item.y2, WALL_R);
          addCapsulePath(wallCore, item.x1, item.y1, item.x2, item.y2, 3);
          break;
        case 'booster': {
          boostBody.appendRect(item.x, item.y, item.w, item.h, { rx: 14, ry: 14 });
          const midX = item.x + item.w / 2;
          const half = item.w * 0.3;
          for (let i = 0; i < 3; i++) {
            const cy = item.y + 14 + (i * (item.h - 28)) / 2;
            boostArrow.moveTo(midX - half, cy);
            boostArrow.lineTo(midX, cy + 18);
            boostArrow.lineTo(midX + half, cy);
            boostArrow.lineTo(midX + half - 10, cy);
            boostArrow.lineTo(midX, cy + 8);
            boostArrow.lineTo(midX - half + 10, cy);
            boostArrow.close();
          }
          break;
        }
        case 'decal':
          // The artwork itself is drawn by the decal layer, behind everything.
          // Here it only gets an edge, so an empty or faint piece stays findable.
          decalEdge.appendRect(item.x, item.y, item.w, item.h);
          break;
        default: {
          // Same three passes the race board uses: shell, body, lit core.
          this.#addMotionRange(range, item, px);
          const hot = isHot(item);
          addPartsPath(hot ? hotShell : machineShell, item, 1);
          addPartsPath(hot ? hotBody : machineBody, item, 0.62);
          addPartsPath(hot ? hotLight : machineLight, item, 0.24);
          break;
        }
      }
    }

    decalEdge.stroke({ width: px, color: [190, 205, 225, 60], dash: [px * 5, px * 5] });

    const boost = UI.boost;
    boostBody
      .fill(boost[0], boost[1], boost[2], 34)
      .stroke({ width: 1.5, color: [boost[0], boost[1], boost[2], 90] });
    const bright = lighten(boost, 0.2);
    boostArrow.fill(bright[0], bright[1], bright[2], 165);

    wallBody.fill(UI.track[0], UI.track[1], UI.track[2], 255);
    wallCore.fill(UI.trackLight[0], UI.trackLight[1], UI.trackLight[2], 150);

    range.stroke({ width: px, color: [255, 255, 255, 46], dash: [px * 7, px * 7] });

    paintMachinery(machineShell, machineBody, machineLight, UI.machine);
    paintMachinery(hotShell, hotBody, hotLight, UI.hot);

    pegBody.fill(UI.peg[0], UI.peg[1], UI.peg[2], 255).stroke({ width: 1.4, color: [16, 24, 52, 220] });
    pegShine.fill(UI.pegLight[0], UI.pegLight[1], UI.pegLight[2], 150);
    bumperBody.fill(UI.bumper[0], UI.bumper[1], UI.bumper[2], 255).stroke({ width: 2, color: [255, 236, 200, 150] });
    bumperShine.fill(UI.bumperLight[0], UI.bumperLight[1], UI.bumperLight[2], 210);
  }

  /** The envelope a moving part sweeps, so its motion reads while it sits still. */
  #addMotionRange(shape: Shape, item: MovingItem, px: number): void {
    switch (item.kind) {
      case 'spinner':
        if (item.omega !== 0) shape.appendCircle(item.x, item.y, item.length);
        break;
      case 'pendulum': {
        if (item.amp <= 0.01) break;
        for (const side of [-1, 1]) {
          const angle = item.amp * side;
          shape.moveTo(item.x, item.y);
          shape.lineTo(item.x - Math.sin(angle) * item.length, item.y + Math.cos(angle) * item.length);
        }
        break;
      }
      case 'slider': {
        if (item.travel <= 0.01) break;
        const halfHeight = Math.max(6, item.halfLength * Math.abs(item.tilt));
        shape.appendRect(
          item.x - item.travel - item.halfLength,
          item.y - halfHeight,
          (item.travel + item.halfLength) * 2,
          halfHeight * 2,
          { rx: px * 4, ry: px * 4 },
        );
        break;
      }
    }
  }

  /* --------------------------------------------------------------- chrome */

  #drawChrome(frame: EditorFrame, px: number, top: number, bottom: number): void {
    const hover = this.#shape();
    const selection = this.#shape();
    const finishGrip = this.#shape();
    const ghost = this.#shape();
    const marquee = this.#shape();
    const handleFill = this.#shape();

    for (const item of frame.items) {
      const box = boundsOf(item);
      if (box.y1 < top || box.y0 > bottom) continue;
      if (frame.selected.has(item.id)) addOutline(selection, item, px * 3);
      else if (frame.hover === item.id) addOutline(hover, item, px * 2.5);
    }

    hover.stroke({ width: px * 1.4, color: [HOVER[0], HOVER[1], HOVER[2], 140] });
    selection.stroke({ width: px * 2, color: [SELECT[0], SELECT[1], SELECT[2], 235] });

    // Finish line grip: a full width bar the pointer can grab anywhere.
    if (frame.finishActive) {
      finishGrip
        .appendRect(COURSE.left - 12, frame.finishY - px * 5, COURSE.right - COURSE.left + 24, px * 10, {
          rx: px * 5,
          ry: px * 5,
        })
        .fill(FINISH_MARK[0], FINISH_MARK[1], FINISH_MARK[2], 220);
    }

    if (frame.ghost) {
      addItemPath(ghost, frame.ghost);
      ghost
        .fill(SELECT[0], SELECT[1], SELECT[2], 60)
        .stroke({ width: px * 1.4, color: [SELECT[0], SELECT[1], SELECT[2], 190], dash: [px * 6, px * 5] });
    }

    if (frame.marquee) {
      const box: Box = frame.marquee;
      marquee
        .appendRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0)
        .fill(SELECT[0], SELECT[1], SELECT[2], 26)
        .stroke({ width: px * 1.2, color: [SELECT[0], SELECT[1], SELECT[2], 190], dash: [px * 5, px * 4] });
    }

    const size = HANDLE_SIZE * px;
    for (const handle of frame.handles) {
      handleFill.appendRect(handle.x - size, handle.y - size, size * 2, size * 2, { rx: size * 0.4, ry: size * 0.4 });
    }
    handleFill
      .fill(SELECT[0], SELECT[1], SELECT[2], 255)
      .stroke({ width: px * 1.4, color: [10, 14, 18, 235] });
  }
}

/** Shell, body and lit core, the three tone treatment the race board uses. */
function paintMachinery(shell: Shape, body: Shape, light: Shape, base: RGB): void {
  const dark = darken(base, 0.35);
  const lit = lighten(base, 0.55);
  shell.fill(dark[0], dark[1], dark[2], 255);
  body.fill(base[0], base[1], base[2], 255);
  light.fill(lit[0], lit[1], lit[2], 210);
}

/* ------------------------------------------------------------- geometry */

/** Appends an obstacle's parts at its rest pose, radii scaled by `weight`. */
function addPartsPath(shape: Shape, item: MovingItem, weight: number, grow = 0): void {
  const { angle, ox } = restPose(item);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = item.x + ox;
  const cy = item.y;

  for (const part of partsOf(item)) {
    if (part.kind === 'circle') {
      shape.appendCircle(cx + part.cx * cos - part.cy * sin, cy + part.cx * sin + part.cy * cos, part.r * weight + grow);
      continue;
    }
    addCapsulePath(
      shape,
      cx + part.ax * cos - part.ay * sin,
      cy + part.ax * sin + part.ay * cos,
      cx + part.bx * cos - part.by * sin,
      cy + part.bx * sin + part.by * cos,
      Math.max(0.5, part.r * weight + grow),
    );
  }
}

/** The item's own silhouette, used for the placement ghost. */
function addItemPath(shape: Shape, item: MapItem): void {
  addOutline(shape, item, 0);
}

/** The item's silhouette expanded by `grow`, used for hover and selection. */
function addOutline(shape: Shape, item: MapItem, grow: number): void {
  switch (item.kind) {
    case 'peg':
      shape.appendCircle(item.x, item.y, item.r + grow);
      break;
    case 'wall':
      addCapsulePath(shape, item.x1, item.y1, item.x2, item.y2, WALL_R + grow);
      break;
    case 'booster':
      shape.appendRect(item.x - grow, item.y - grow, item.w + grow * 2, item.h + grow * 2, {
        rx: 14 + grow,
        ry: 14 + grow,
      });
      break;
    case 'decal':
      shape.appendRect(item.x - grow, item.y - grow, item.w + grow * 2, item.h + grow * 2);
      break;
    default:
      addPartsPath(shape, item, 1, grow);
      break;
  }
}
