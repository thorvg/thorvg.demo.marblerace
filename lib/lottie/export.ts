/**
 * Bakes a race into a Lottie.
 *
 * The board is already vector, which is what makes this worth doing: the
 * course, the machinery and the marbles go out as shapes and keyframes rather
 * than as pixels, so the result scales without limit, opens in any Lottie tool
 * and is a fraction of the size of the equivalent video.
 *
 * What each part costs decides how it is written down:
 *
 * - The course never moves, so it is one static layer of batched groups.
 * - A spinner turns at a constant rate, so it is two keyframes and no more,
 *   however long the race runs. Pendulums and sliders are sinusoidal, so they
 *   are sampled per frame.
 * - Marbles are chaotic. They are the one thing that genuinely needs a sample
 *   per frame, and they dominate the file.
 * - The camera becomes a parent transform every world layer hangs from, which
 *   is exactly what it already is on the board.
 *
 * Artwork carried by a map comes across whole: a still becomes an embedded
 * image asset, and an embedded Lottie becomes a precomposition, retimed into
 * this file's frame rate and repeated to cover the run.
 *
 * Deliberately not exported, because the format has no honest equivalent:
 * impact sparks and confetti (thousands of one-shot layers), additive blending
 * and glow, and the interface text, which is laid out in screen space against a
 * viewport this file does not have.
 */

import { COURSE } from '../board';
import { UI, darken, lighten, marbleColor } from '../palette';
import { skinPayload, type Skin } from '../skins';
import type { Course, Decal, Obstacle, Peg, RGB } from '../types';
import { recordRace, type RecordOptions } from './record';
import {
  animated,
  capsule,
  ellipse,
  fill,
  fixed,
  group,
  imageLayer,
  nullLayer,
  path,
  precompLayer,
  radial,
  rect,
  scalar,
  shapeLayer,
  stroke,
  type Asset,
  type ImageAsset,
  type Layer,
  type LottieDocument,
  type ShapeItem,
  type Transform,
} from './schema';

const VERSION = '5.9.0';
const BAND = 900;

/**
 * Points a baked trail carries. Fewer than the board draws: a trail needs a
 * path keyframe on every frame of every runner, which is the one part of this
 * export whose cost grows with all three of length, roster and detail.
 */
const TRAIL_POINTS = 8;

/** Board pixels the composition is authored at, matching the camera's own box. */
const WIDTH = COURSE.viewWidth;
const HEIGHT = COURSE.viewHeight;

/**
 * Assembly state.
 *
 * Layers are collected into bands rather than one list, because a Lottie paints
 * its first layer on top: the order they are written in is the reverse of the
 * order they are built in, and keeping the bands apart is what stops that from
 * becoming a source of quiet mistakes.
 */
interface Build {
  fps: number;
  frames: number;
  assets: Asset[];
  /** Layers are numbered from one, and a parent is referenced by that number. */
  next: number;
  back: Layer[];
  deco: Layer[];
  track: Layer[];
  machines: Layer[];
  trails: Layer[];
  balls: Layer[];
}

/* --------------------------------------------------------------- artwork */

/**
 * Rewrites an embedded animation into this file's timebase.
 *
 * A precomposition shares the frame rate of the file it sits in, so a decal
 * authored at 60fps would otherwise play at half speed in a 30fps export. Every
 * time in the source — keyframe stamps, layer in and out points — is scaled
 * once, here, which leaves nothing for a player to have to guess at.
 */
function retime(value: unknown, factor: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => retime(entry, factor));
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if ((key === 't' || key === 'ip' || key === 'op' || key === 'st') && typeof entry === 'number') {
      out[key] = Math.round(entry * factor * 1000) / 1000;
    } else {
      out[key] = retime(entry, factor);
    }
  }
  return out;
}

let uid = 0;

function nextId(prefix: string): string {
  return `${prefix}_${uid++}`;
}

/**
 * Folds an embedded Lottie into this document as a precomposition.
 *
 * Its own assets come along with it under fresh ids, because two animations
 * that were each authored alone will happily both call an image `image_0`.
 */
function embedLottie(build: Build, json: Record<string, unknown>, fps: number): { id: string; frames: number } | null {
  const layers = json.layers;
  if (!Array.isArray(layers)) return null;

  const sourceFps = typeof json.fr === 'number' && json.fr > 0 ? json.fr : fps;
  const factor = fps / sourceFps;

  const rename = new Map<string, string>();
  const sourceAssets = Array.isArray(json.assets) ? (json.assets as Array<Record<string, unknown>>) : [];
  for (const asset of sourceAssets) {
    if (typeof asset.id === 'string') rename.set(asset.id, nextId('embedded'));
  }

  const relabel = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(relabel);
    if (!value || typeof value !== 'object') return value;
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if ((key === 'id' || key === 'refId') && typeof entry === 'string' && rename.has(entry)) {
        out[key] = rename.get(entry);
      } else {
        out[key] = relabel(entry);
      }
    }
    return out;
  };

  for (const asset of sourceAssets) {
    build.assets.push(retime(relabel(asset), factor) as Asset);
  }

  const id = nextId('comp');
  build.assets.push({ id, layers: retime(relabel(layers), factor) as Layer[] });

  const op = typeof json.op === 'number' ? json.op : 0;
  const ip = typeof json.ip === 'number' ? json.ip : 0;
  return { id, frames: Math.max(1, Math.round((op - ip) * factor)) };
}

/** An embedded still, which the format carries as a base64 image asset. */
function embedImage(build: Build, skin: Skin, w: number, h: number): string | null {
  if (skin.type === 'lot') return null;
  const id = nextId('image');
  build.assets.push({ id, p: skin.uri, u: '', e: 1, w: Math.round(w), h: Math.round(h) } satisfies ImageAsset);
  return id;
}

/**
 * Places a piece of artwork, whichever kind it is.
 *
 * A Lottie becomes a precomposition, laid end to end so it keeps playing for as
 * long as the race lasts rather than stopping partway through. A still becomes
 * an embedded image. Both are fitted to the box the map gave them.
 */
function placeArtwork(
  build: Build,
  into: Layer[],
  art: Skin,
  box: { x: number; y: number; w: number; h: number },
  parent: number,
  opacity: number,
  name: string,
): void {
  if (art.type === 'lot') {
    const payload = skinPayload(art);
    if (typeof payload !== 'string') return;

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }

    const width = typeof json.w === 'number' && json.w > 0 ? json.w : box.w;
    const height = typeof json.h === 'number' && json.h > 0 ? json.h : box.h;
    const comp = embedLottie(build, json, build.fps);
    if (!comp) return;

    // A precomposition renders at its own size, so the box is met with a scale.
    const transform: Partial<Transform> = {
      p: fixed([box.x, box.y]),
      a: fixed([0, 0]),
      o: fixed(opacity),
      s: fixed([(box.w / width) * 100, (box.h / height) * 100]),
    };

    const repeats = Math.min(240, Math.max(1, Math.ceil(build.frames / comp.frames)));
    for (let i = 0; i < repeats; i++) {
      const start = i * comp.frames;
      const layer = precompLayer(
        {
          name: `${name} ${i + 1}`,
          index: build.next++,
          frames: Math.min(build.frames, start + comp.frames),
          transform,
          parent,
          ip: start,
        },
        comp.id,
        width,
        height,
      );
      layer.st = start;
      into.push(layer);
    }
    return;
  }

  const id = embedImage(build, art, box.w, box.h);
  if (!id) return;
  into.push(
    imageLayer(
      {
        name,
        index: build.next++,
        frames: build.frames,
        transform: {
          p: fixed([box.x, box.y]),
          a: fixed([0, 0]),
          o: fixed(opacity),
        },
        parent,
      },
      id,
    ),
  );
}

/* ------------------------------------------------------------ the course */

function pegShapes(pegs: Peg[]): ShapeItem[] {
  const plain = pegs.filter((peg) => !peg.bumper);
  const bumpers = pegs.filter((peg) => peg.bumper);
  const shapes: ShapeItem[] = [];

  if (plain.length) {
    shapes.push(group(plain.map((peg) => ellipse(peg.x, peg.y, peg.r)).concat(fill(UI.peg)), 'pegs'));
    shapes.push(
      group(
        plain
          .map((peg) => ellipse(peg.x - peg.r * 0.22, peg.y - peg.r * 0.3, peg.r * 0.58))
          .concat(fill(UI.pegLight, 59)),
        'peg shine',
      ),
    );
  }

  if (bumpers.length) {
    shapes.push(group(bumpers.map((peg) => ellipse(peg.x, peg.y, peg.r)).concat(fill(UI.bumper)), 'bumpers'));
    shapes.push(
      group(
        bumpers
          .map((peg) => ellipse(peg.x - peg.r * 0.24, peg.y - peg.r * 0.28, peg.r * 0.62))
          .concat(fill(UI.bumperLight, 82)),
        'bumper shine',
      ),
    );
    shapes.push(
      group(bumpers.map((peg) => ellipse(peg.x, peg.y, peg.r * 0.26)).concat(fill([90, 44, 14], 70)), 'bumper caps'),
    );
  }

  return shapes;
}

function courseShapes(course: Course): ShapeItem[] {
  const shapes: ShapeItem[] = [];

  // Rails, and the distance ticks that sell the descent.
  shapes.push(
    group(
      [
        ...capsule(COURSE.left, 40, COURSE.left, course.height - 40, 7),
        ...capsule(COURSE.right, 40, COURSE.right, course.height - 40, 7),
        fill([65, 76, 87]),
      ],
      'rails',
    ),
  );

  const ticks: ShapeItem[] = [];
  for (let y = 260; y < course.height - 200; y += 240) {
    ticks.push(rect(COURSE.left + 23, y + 2, 26, 4, 2), rect(COURSE.right - 23, y + 2, 26, 4, 2));
  }
  if (ticks.length) shapes.push(group([...ticks, fill(UI.trackLight, 22)], 'ticks'));

  // Ramps: the shell first, then the lighter core running through it.
  if (course.walls.length) {
    const rail: ShapeItem[] = [];
    const core: ShapeItem[] = [];
    for (const wall of course.walls) {
      rail.push(...capsule(wall.x1, wall.y1, wall.x2, wall.y2, 8));
      core.push(...capsule(wall.x1, wall.y1, wall.x2, wall.y2, 3));
    }
    shapes.push(group([...rail, fill(UI.track)], 'ramps'));
    shapes.push(group([...core, fill(UI.trackLight, 59)], 'ramp cores'));
  }

  // Boost pads, with their chevrons held still: the scroll is a shader-ish
  // flourish on the board and would cost a keyframe a frame here.
  if (course.boosters.length) {
    const bodies: ShapeItem[] = [];
    const arrows: ShapeItem[] = [];
    for (const pad of course.boosters) {
      bodies.push(rect(pad.x + pad.w / 2, pad.y + pad.h / 2, pad.w, pad.h, 14));
      const midX = pad.x + pad.w / 2;
      const half = pad.w * 0.3;
      for (let i = 0; i < 3; i++) {
        const cy = pad.y + 14 + (i * (pad.h - 28)) / 2;
        arrows.push(
          path([
            [midX - half, cy],
            [midX, cy + 18],
            [midX + half, cy],
            [midX + half - 10, cy],
            [midX, cy + 8],
            [midX - half + 10, cy],
          ]),
        );
      }
    }
    shapes.push(group([...bodies, fill(UI.boost, 13), stroke(UI.boost, 1.5, 35)], 'boost pads'));
    shapes.push(group([...arrows, fill(lighten(UI.boost, 0.2), 65)], 'boost arrows'));
  }

  // The finish: bed, chequer, line and the ring under it.
  const y = course.finishY;
  const span = COURSE.right - COURSE.left;
  shapes.push(group([rect(COURSE.left + span / 2, y + 16, span, 44, 8), fill([10, 16, 36], 78)], 'finish bed'));

  const light: ShapeItem[] = [];
  const dark: ShapeItem[] = [];
  const cell = 22;
  for (let i = 0; i * cell < span; i++) {
    for (let row = 0; row < 2; row++) {
      const x = COURSE.left + i * cell;
      const w = Math.min(cell, COURSE.right - x);
      ((i + row) % 2 === 0 ? light : dark).push(rect(x + w / 2, y + row * 16 + 8, w, 16));
    }
  }
  shapes.push(group([...dark, fill([18, 26, 54], 82)], 'chequer dark'));
  shapes.push(group([...light, fill(UI.finish, 75)], 'chequer light'));
  shapes.push(group([rect(COURSE.left + span / 2, y - 1.5, span, 5, 2.5), fill(UI.gold, 80)], 'finish line'));
  shapes.push(
    group([ellipse(course.goal.x, course.goal.y, course.goalRadius), stroke(UI.goal, 4, 55)], 'goal ring'),
  );

  // Pegs last, so they read as sitting on top of the ramps they share a band with.
  for (let band = 0; band * BAND < course.height; band++) {
    const top = band * BAND;
    const pegs = course.pegs.filter((peg) => peg.y >= top && peg.y < top + BAND);
    if (pegs.length) shapes.push(...pegShapes(pegs));
  }

  return shapes;
}

/* --------------------------------------------------------------- machinery */

function obstacleShapes(obstacle: Obstacle): ShapeItem[] {
  const base: RGB = obstacle.hot ? UI.hot : UI.machine;
  const shell: ShapeItem[] = [];
  const body: ShapeItem[] = [];
  const lit: ShapeItem[] = [];

  for (const part of obstacle.parts) {
    if (part.kind === 'circle') {
      shell.push(ellipse(part.cx, part.cy, part.r));
      body.push(ellipse(part.cx, part.cy, part.r * 0.62));
      lit.push(ellipse(part.cx, part.cy, part.r * 0.24));
      continue;
    }
    shell.push(...capsule(part.ax, part.ay, part.bx, part.by, part.r));
    body.push(...capsule(part.ax, part.ay, part.bx, part.by, Math.max(0.5, part.r * 0.62)));
    lit.push(...capsule(part.ax, part.ay, part.bx, part.by, Math.max(0.5, part.r * 0.24)));
  }

  // The same three passes the board uses: shell, body, lit core.
  return [
    group([...shell, fill(darken(base, 0.35))], 'shell'),
    group([...body, fill(base)], 'body'),
    group([...lit, fill(lighten(base, 0.55), 82)], 'core'),
  ];
}

/* ---------------------------------------------------------------- marbles */

/** A circle as bezier path data, which is what a Lottie mask needs. */
function circlePath(radius: number): { i: number[][]; o: number[][]; v: number[][]; c: boolean } {
  const k = 0.5522847498307936 * radius;
  return {
    v: [
      [radius, 0],
      [0, radius],
      [-radius, 0],
      [0, -radius],
    ],
    o: [
      [0, k],
      [-k, 0],
      [0, -k],
      [k, 0],
    ],
    i: [
      [0, -k],
      [k, 0],
      [0, k],
      [-k, 0],
    ],
    c: true,
  };
}

/**
 * The artwork a runner carries, clipped to the ball.
 *
 * The mask is what makes a skin read as painted onto a marble rather than
 * pasted over it, and it is the one place this export needs a Lottie feature
 * beyond shapes and keyframes.
 */
function addSkin(build: Build, skin: Skin, parent: number, radius: number, name: string): void {
  const before = build.balls.length;
  placeArtwork(build, build.balls, skin, { x: -radius, y: -radius, w: radius * 2, h: radius * 2 }, parent, 100, name);

  for (let i = before; i < build.balls.length; i++) {
    const layer = build.balls[i];
    layer.hasMask = true;
    layer.masksProperties = [
      { inv: false, mode: 'a', nm: 'ball', pt: fixed(circlePath(radius)), o: fixed(100), x: fixed(0) },
    ];
  }
}

/* ----------------------------------------------------------------- export */

export interface ExportOptions extends RecordOptions {
  /** Artwork each runner carries, keyed by name. */
  skinFor?: (name: string) => Skin | undefined;
}

export interface ExportResult {
  document: LottieDocument;
  /** Seconds the baked animation runs for. */
  seconds: number;
  layers: number;
  bytes: number;
}

/**
 * Bakes a race into a Lottie document.
 *
 * The board's own camera becomes a null layer every world layer hangs from, so
 * the file reproduces the run as it was watched rather than as a flat map.
 */
export function exportRace(options: ExportOptions): ExportResult {
  const recording = recordRace(options);
  const course = options.course;
  const frames = recording.frames.length;

  const build: Build = {
    fps: recording.fps,
    frames,
    assets: [],
    next: 1,
    back: [],
    deco: [],
    track: [],
    machines: [],
    trails: [],
    balls: [],
  };

  // The camera, as the board applies it: the world is scaled by the zoom and
  // slid so the camera's target lands in the middle of the frame.
  const world = nullLayer({
    name: 'camera',
    index: build.next++,
    frames,
    transform: {
      p: animated(
        recording.frames.map((frame) => [
          WIDTH / 2 - frame.camera.x * frame.camera.zoom,
          HEIGHT / 2 - frame.camera.y * frame.camera.zoom,
        ]),
      ),
      s: animated(recording.frames.map((frame) => [frame.camera.zoom * 100, frame.camera.zoom * 100])),
      a: fixed([0, 0]),
    },
  });
  const parent = world.ind;

  // Backdrop: flat, and in screen space, so it does not travel with the board.
  build.back.push(
    shapeLayer({ name: 'backdrop', index: build.next++, frames }, [
      group([rect(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT), fill([13, 15, 19])], 'sky'),
    ]),
  );

  // Map artwork, behind the track exactly as the board lays it.
  course.decals.forEach((decal: Decal, i) => {
    placeArtwork(
      build,
      build.deco,
      decal.art,
      { x: decal.x, y: decal.y, w: decal.w, h: decal.h },
      parent,
      decal.opacity,
      `artwork ${i + 1}`,
    );
  });

  build.track.push(
    shapeLayer({ name: 'course', index: build.next++, frames, parent }, courseShapes(course)),
  );

  // Machinery. A spinner turns at a constant rate, so two keyframes describe it
  // however long the race is; the rest are sinusoidal and sampled per frame.
  course.obstacles.forEach((obstacle, i) => {
    const angles = recording.frames.map((frame) => frame.obstacles[i]?.angle ?? 0);
    const offsets = recording.frames.map((frame) => frame.obstacles[i]?.ox ?? 0);
    const linear = obstacle.motion === 'spin' && angles.length > 1;

    build.machines.push(
      shapeLayer(
        {
          name: `machine ${i + 1}`,
          index: build.next++,
          frames,
          parent,
          transform: {
            p: animated(offsets.map((ox) => [obstacle.pivotX + ox, obstacle.pivotY])),
            r: linear
              ? { a: 1, k: [{ t: 0, s: [angles[0]], i: { x: [1], y: [1] }, o: { x: [0], y: [0] } }, { t: frames - 1, s: [angles[angles.length - 1]] }] }
              : scalar(angles),
            a: fixed([0, 0]),
          },
        },
        obstacleShapes(obstacle),
      ),
    );
  });

  // Marbles, and the artwork they carry.
  const skinFor = options.skinFor;
  recording.names.forEach((name, i) => {
    const colour = marbleColor(i);
    const radius = recording.radius;
    const samples = recording.frames.map((frame) => frame.marbles[i]);
    const skin = skinFor?.(name);

    const ball = shapeLayer(
      {
        name,
        index: build.next++,
        frames,
        parent,
        transform: {
          p: animated(samples.map((sample) => [sample.x, sample.y])),
          o: scalar(samples.map((sample) => (sample.visible ? 100 : 0))),
          a: fixed([0, 0]),
        },
      },
      skin
        ? []
        : [
            group([ellipse(0, 0, radius), radial(lighten(colour, 0.45), darken(colour, 0.3), -radius * 0.34, -radius * 0.4, radius * 1.6)], 'ball'),
            group([ellipse(-radius * 0.3, -radius * 0.34, radius * 0.34), fill([255, 255, 255], 45)], 'gloss'),
          ],
    );
    build.balls.push(ball);

    if (skin) {
      // A skinned marble is a rolling picture, so the ball layer becomes the
      // anchor the artwork hangs from and stops drawing itself.
      ball.ks.r = scalar(samples.map((sample) => sample.spin));
      addSkin(build, skin, ball.ind, radius, `${name} artwork`);
    }
  });

  // Trails: an open polyline through the sampled positions, stroked in the
  // runner's colour. Every keyframe has to carry the same number of vertices,
  // so a short trail repeats its oldest point rather than changing shape.
  if (options.trails) {
    recording.names.forEach((name, i) => {
      const points = TRAIL_POINTS;
      const keys = recording.frames.map((frame, f) => {
        const flat = frame.trails[i] ?? [];
        const have = Math.floor(flat.length / 2);
        const vertices: number[][] = [];
        for (let p = 0; p < points; p++) {
          const at = Math.max(0, have - points + p);
          vertices.push(have ? [flat[at * 2], flat[at * 2 + 1]] : [frame.marbles[i].x, frame.marbles[i].y]);
        }
        const zero = vertices.map(() => [0, 0]);
        return {
          t: f,
          s: [{ i: zero, o: zero.map((z) => [...z]), v: vertices, c: false }],
          i: { x: [1], y: [1] },
          o: { x: [0], y: [0] },
        };
      });

      build.trails.push(
        shapeLayer({ name: `${name} trail`, index: build.next++, frames, parent }, [
          group(
            [
              { ty: 'sh', ks: { a: 1, k: keys } },
              // Thinner and fainter than the board's ribbon: a uniform stroke
              // cannot taper, so it earns its place by reading as motion
              // rather than by pretending to be the same shape.
              stroke(lighten(marbleColor(i), 0.3), recording.radius * 0.5, 26),
            ],
            'trail',
          ),
        ]),
      );
    });
  }

  // First layer paints on top, so the bands go out in reverse of how they read.
  const layers = [
    ...build.balls,
    ...build.trails,
    ...build.machines,
    ...build.track,
    ...build.deco,
    ...build.back,
    world,
  ];

  const document: LottieDocument = {
    v: VERSION,
    fr: recording.fps,
    ip: 0,
    op: frames,
    w: WIDTH,
    h: HEIGHT,
    nm: `Thor Marble Race — ${options.seed}`,
    ddd: 0,
    assets: build.assets,
    layers,
  };

  const json = JSON.stringify(document);
  return { document, seconds: frames / recording.fps, layers: layers.length, bytes: json.length };
}

export function exportToJson(result: ExportResult): string {
  return JSON.stringify(result.document);
}
