/**
 * Runs a race with nothing attached to it.
 *
 * The simulation, the course and the camera are all plain TypeScript with no
 * DOM and no engine behind them, so a whole run can be played out headlessly
 * and sampled once per export frame. That is what makes the Lottie export
 * possible at all: it is the same physics the board runs, just written down
 * instead of drawn.
 *
 * The camera mirrors the stage's racing branch — follow the leader, ease
 * towards it — but not its shake, which is a response to impacts the export has
 * no way to reproduce and would only add jitter to a vector file.
 */

import { COURSE } from '../board';
import { Camera } from '../camera';
import { driveObstacles } from '../course';
import { hashSeed } from '../rng';
import { FIXED_DT, Simulation } from '../sim';
import type { Course, RaceMode } from '../types';

/** Trail points sampled per marble, matching the board's own ring buffer. */
const TRAIL_POINTS = 18;

export interface RecordOptions {
  course: Course;
  names: readonly string[];
  seed: string;
  mode: RaceMode;
  fps: number;
  /** Hard stop, so a map nobody can finish still produces a file. */
  maxSeconds: number;
  trails: boolean;
}

export interface MarbleSample {
  x: number;
  y: number;
  /** Rolling angle in degrees, which only shows on a skinned marble. */
  spin: number;
  visible: boolean;
}

export interface Frame {
  camera: { x: number; y: number; zoom: number };
  marbles: MarbleSample[];
  /** One entry per obstacle: its angle in degrees and its slide offset. */
  obstacles: Array<{ angle: number; ox: number }>;
  /** Flattened trail points per marble, newest last. Empty when not recorded. */
  trails: number[][];
}

export interface Recording {
  frames: Frame[];
  fps: number;
  radius: number;
  /** Index of the marble that won, or -1 if nobody did. */
  winner: number;
  names: string[];
}

/**
 * Plays the race out and samples it.
 *
 * Physics still advances on its own fixed step, exactly as it does on the
 * board; only the sampling rate changes. A slower export therefore describes
 * the same race, not a different one.
 */
export function recordRace(options: RecordOptions): Recording {
  const { course, names, seed, mode, fps, maxSeconds, trails } = options;

  const sim = new Simulation(course, names, hashSeed(`${seed}:${names.join('|')}`));
  sim.updateStandings();

  const camera = new Camera();
  camera.setView(COURSE.viewWidth, COURSE.viewHeight);
  camera.snap(COURSE.width / 2, COURSE.releaseY + 220, 1);

  const dt = 1 / fps;
  const maxFrames = Math.ceil(maxSeconds * fps);
  const frames: Frame[] = [];

  let accumulator = 0;
  let done = false;
  /** Frames to keep rolling after the result, so the finish is not cut off. */
  let tail = Math.round(fps * 1.5);

  for (let index = 0; index < maxFrames; index++) {
    if (!done) {
      accumulator = Math.min(accumulator + dt, 0.25);
      while (accumulator >= FIXED_DT) {
        sim.step();
        accumulator -= FIXED_DT;
        if (sim.winner && mode === 'winner') break;
      }
      sim.sampleTrails();
      sim.updateStandings();
      camera.follow(sim.standings, course.finishY);

      done =
        mode === 'winner'
          ? sim.winner !== null
          : sim.finishedCount >= sim.marbles.length;
    } else if (tail-- <= 0) {
      break;
    }

    const view = camera.update(dt);
    frames.push({
      camera: { x: view.x, y: view.y, zoom: view.zoom },
      marbles: sim.marbles.map((marble) => ({
        x: round(marble.x),
        y: round(marble.y),
        spin: round((marble.spin * 180) / Math.PI),
        visible: marble.y < course.height + 60,
      })),
      obstacles: course.obstacles.map((obstacle) => ({
        angle: round((obstacle.angle * 180) / Math.PI),
        ox: round(obstacle.ox),
      })),
      trails: trails ? sim.marbles.map((marble) => marble.trail.slice(-TRAIL_POINTS * 2).map(round)) : [],
    });

    // Machinery is driven off course time, which the camera pass does not touch.
    driveObstacles(course, sim.time);
  }

  return {
    frames,
    fps,
    radius: sim.marbles[0]?.r ?? 14,
    winner: sim.winner?.index ?? -1,
    names: sim.marbles.map((marble) => marble.name),
  };
}

/** Two decimals is finer than a pixel at any zoom, and a third of the bytes. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
