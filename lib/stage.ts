/**
 * Stage: owns the ThorVG canvas, the run loop and the race itself.
 *
 * idle -> preview -> countdown -> racing -> reveal
 *
 * Physics runs on a fixed timestep accumulator so the marbles behave the same
 * on a 60 Hz and a 144 Hz display; rendering happens once per animation frame.
 */

import type { Canvas, RendererType, ThorVGNamespace } from '@thorvg/webcanvas';
import { Camera, EDIT_ZOOM, ZOOM } from './camera';
import { blueprintSignature, cloneBlueprint, compile, type Blueprint } from './blueprint';
import { COURSE, MAX_NAMES, TRACK_LENGTHS, createCourse, driveObstacles, type TrackLength } from './course';
import type { MapEditor, PointerInput } from './mapEditor';
import { artworkSize, readSkinFile, type SkinError } from './skins';
import { clamp, easeInOutCubic, easeOutCubic, lerp, span } from './easing';
import { CJK_FONT, LATIN_FONT, fontResolver, loadFont, needsCjk, resetFontRegistry, type FontResolver } from './fonts';
import { getMessages, needsCjkFont, DEFAULT_LOCALE, type Locale, type Messages } from './i18n';
import { Fx } from './fx';
import { MARBLE_COLORS, UI } from './palette';
import type { Banner } from './render/hud';
import { Renderer } from './render/renderer';
import { CanvasRecorder, type RecordedVideo } from './recorder';
import type { Skin } from './skins';
import { Sound } from './sound';
import { renderLottieThumb } from './thumbnail';
import { baseScale } from './render/common';
import { hashSeed, mulberry32 } from './rng';
import type { CameraPose, Vec3 } from './preview';
import { FIXED_DT, Simulation } from './sim';
import type { Course, Marble, Phase, RaceMode, RankEntry, RGB } from './types';

const PREVIEW = 4.5;
const FLATTEN_AT = 3.5;
const COUNTDOWN = 2.4;
const BANNER_LIFE = 2.2;
const REVEAL_SIM_TAIL = 4;
/** How long a ranking run keeps waiting for stragglers after the winner. */
const RANKING_TAIL = 25;

export interface WinnerInfo {
  index: number;
  name: string;
  color: RGB;
  /** Seconds of race time it took. */
  elapsed: number;
  /** Lead over the runner up in world units. */
  margin: number;
  photoFinish: boolean;
  /** Every runner in finishing order. One entry in winner mode. */
  ranking: RankEntry[];
}

export type RecordingState = 'idle' | 'recording' | 'saving';

export type ViewMode = 'board' | 'ride';

/** Marble index to ride with, or the current leader. */
export type FollowTarget = number | 'leader';

export interface StageCallbacks {
  onPhase?: (phase: Phase) => void;
  onWinner?: (winner: WinnerInfo) => void;
  onRecording?: (state: RecordingState) => void;
  onVideo?: (video: RecordedVideo) => void;
}

export interface StageConfig {
  selector: string;
  renderer: RendererType;
  wasmUrl: string;
  width: number;
  height: number;
}

let tvgInstance: ThorVGNamespace | null = null;
let tvgRenderer: RendererType | null = null;
let bootstrap: Promise<unknown> = Promise.resolve();

/** Serialises engine setup so a fast remount never races init()/term(). */
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = bootstrap.then(job, job);
  bootstrap = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Throws away the cached engine. A module that has faulted keeps failing every
 * call, so without this a single bad frame would make every later attempt to
 * start the canvas fail too, and the retry button could never recover.
 */
function dropEngine(): void {
  if (!tvgInstance) return;
  try {
    tvgInstance.term();
  } catch {
    // Already past saving; the reference is dropped either way.
  }
  tvgInstance = null;
  tvgRenderer = null;
  resetFontRegistry();
}

async function ensureEngine(renderer: RendererType, wasmUrl: string): Promise<ThorVGNamespace> {
  if (tvgInstance && tvgRenderer === renderer) return tvgInstance;

  dropEngine();

  const { init } = await import('@thorvg/webcanvas');
  const tvg = await init({
    renderer,
    locateFile: () => wasmUrl,
    // Keep the demo alive if a single paint call complains.
    onError: (error, context) => console.warn('[thorvg]', context.operation, error.message),
  });

  tvgInstance = tvg;
  tvgRenderer = renderer;
  return tvg;
}

/** Where an orbiting pose puts the eye, used to blend into the ride seat. */
function orbitEye(pose: CameraPose): Vec3 {
  const cosPitch = Math.cos(pose.pitch);
  return {
    x: pose.targetX + pose.distance * cosPitch * Math.sin(pose.yaw),
    y: pose.targetY - pose.distance * cosPitch * Math.cos(pose.yaw),
    z: pose.distance * Math.sin(pose.pitch),
  };
}

function mixVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

export class Stage {
  #tvg: ThorVGNamespace;
  #canvas: Canvas;
  #renderer: Renderer;
  #backend: RendererType;
  #callbacks: StageCallbacks;
  #camera = new Camera();

  #course: Course;
  #fx: Fx;
  #sim: Simulation;
  #names: string[] = [];
  #seed = 'THORVG';
  #track: TrackLength = 'standard';
  #speed = 1;

  #phase: Phase = 'idle';
  #phaseTime = 0;
  #time = 0;
  #accumulator = 0;
  #finishEnergy = 0;
  #revealTime = 0;
  #marks = { waves: 0, confetti: false, sides: false, sparkle: 0 };

  #preview: CameraPose = {
    targetX: COURSE.width / 2,
    targetY: COURSE.releaseY,
    distance: 1500,
    yaw: 0,
    pitch: 0.55,
    fov: 0.85,
    flatten: 0,
  };
  #previewAlpha = 0;
  #view: ViewMode = 'board';
  #follow: FollowTarget = 'leader';
  /** 0 is the flat board, 1 is the full ride camera. */
  #rideBlend = 0;
  #heading = { x: 0, y: 1 };
  #rideEye = { x: COURSE.width / 2, y: 0 };
  #rideSeeded = false;
  #ride: CameraPose = {
    targetX: COURSE.width / 2,
    targetY: 0,
    distance: 600,
    yaw: 0,
    pitch: 0.5,
    fov: 1.02,
    flatten: 0,
    behind: 520,
    ahead: 2900,
  };
  #banner: Banner | null = null;
  #leaderIndex = -1;
  #lastLeadChange = 0;
  #finalCalled = false;

  #editor: MapEditor | null = null;
  /** A hand drawn map, used instead of the seeded generator when set. */
  #custom: Blueprint | null = null;
  /** Serialised form of the map in use, so a repeat apply is a no-op. */
  #customKey: string | null = null;
  /** Pointers currently down on the board, keyed by pointer id. */
  #touches = new Map<number, { x: number; y: number }>();
  #pan: { x: number; y: number; camX: number; camY: number } | null = null;
  #pinch: { distance: number; zoom: number } | null = null;
  #spaceHeld = false;

  /** Marble artwork, keyed by runner name. */
  #skins: Record<string, Skin> = {};
  #sound = new Sound();
  /** Marbles currently on a boost pad, so a pad is heard once per visit. */
  #boosting = new Set<number>();
  /** Countdown beat last sounded. */
  #countBeat = 0;
  #mode: RaceMode = 'winner';
  /** Runners already announced as they crossed, in ranking mode. */
  #announced = 0;
  #cjkReady = false;
  #locale: Locale = DEFAULT_LOCALE;
  #text: Messages['canvas'] = getMessages(DEFAULT_LOCALE).canvas;
  #element: HTMLCanvasElement | null = null;
  #recorder: CanvasRecorder | null = null;
  #recordEnabled = false;
  #recordArmed = false;
  /**
   * While recording, the drawing buffer is pinned to the size the encoder was
   * started with. A mid take resize would change the capture resolution and
   * MediaRecorder cannot re-initialise its encoder, which corrupts the file.
   */
  #lockedSize: { width: number; height: number } | null = null;

  #fontFor: FontResolver;
  #raf = 0;
  #last = 0;
  #alive = true;
  #width = 1;
  #height = 1;

  private constructor(tvg: ThorVGNamespace, canvas: Canvas, config: StageConfig, callbacks: StageCallbacks) {
    this.#tvg = tvg;
    this.#canvas = canvas;
    this.#backend = config.renderer;
    this.#callbacks = callbacks;

    this.#element = document.querySelector<HTMLCanvasElement>(config.selector);
    if (this.#element) this.#recorder = new CanvasRecorder(this.#element);
    this.#fontFor = fontResolver(false);
    this.#width = config.width;
    this.#height = config.height;

    this.#course = createCourse(hashSeed(this.#seed), TRACK_LENGTHS[this.#track]);
    this.#fx = new Fx(mulberry32(0x9e3779b9));
    this.#sim = new Simulation(this.#course, [], 1);
    this.#renderer = new Renderer(tvg, canvas, this.#course, LATIN_FONT);
    this.#renderer.layout(config.width, config.height);
    this.#renderer.configureRun(this.#sim.marbles, this.#fontFor, (name) => this.#skins[name]);
    const view = this.#renderer.worldView;
    this.#camera.setView(view.width, view.height);
    this.#camera.snap(COURSE.width / 2, COURSE.releaseY + 220, 1);
  }

  static create(config: StageConfig, callbacks: StageCallbacks = {}): Promise<Stage> {
    return serial(async () => {
      try {
        const tvg = await ensureEngine(config.renderer, config.wasmUrl);
        await loadFont(tvg, LATIN_FONT);

        const canvas = new tvg.Canvas(config.selector, { width: config.width, height: config.height });
        const stage = new Stage(tvg, canvas, config, callbacks);
        stage.#loop(performance.now());
        return stage;
      } catch (error) {
        dropEngine();
        throw error;
      }
    });
  }

  get phase(): Phase {
    return this.#phase;
  }

  resize(width: number, height: number): void {
    if (!this.#alive) return;
    this.#width = width;
    this.#height = height;

    if (this.#lockedSize) {
      this.#fitLocked();
      return;
    }

    this.#canvas.resize(width, height);
    this.#renderer.layout(width, height);
    const view = this.#renderer.worldView;
    this.#camera.setView(view.width, view.height);
  }

  /** Scales the pinned drawing buffer to fill the box without distorting it. */
  #fitLocked(): void {
    const locked = this.#lockedSize;
    const element = this.#element;
    if (!locked || !element) return;

    const scale = Math.min(this.#width / locked.width, this.#height / locked.height);
    element.style.width = `${Math.round(locked.width * scale)}px`;
    element.style.height = `${Math.round(locked.height * scale)}px`;
  }

  #unlockSize(): void {
    if (!this.#lockedSize) return;
    this.#lockedSize = null;
    this.resize(this.#width, this.#height);
  }

  setSpeed(speed: number): void {
    this.#speed = speed;
  }

  /** Stop at the winner, or run the whole field in for a full ranking. */
  setMode(mode: RaceMode): void {
    this.#mode = mode;
  }

  /** Board view or riding along with one of the marbles. */
  setView(mode: ViewMode, follow: FollowTarget): void {
    this.#view = mode;
    this.#follow = follow;
    if (mode === 'board' && this.#phase === 'racing') {
      this.#rideBlend = 0;
      this.#previewAlpha = 0;
      this.#renderer.setWorldVisible(true);
    }
  }

  /** Arms the recorder. The file is produced when the next race finishes. */
  setRecording(enabled: boolean): void {
    this.#recordEnabled = enabled;
    if (!enabled) this.#stopRecording(false);
  }

  /** Swaps the strings ThorVG draws, and pulls in a CJK face when needed. */
  setLocale(locale: Locale): void {
    if (!this.#alive) return;
    this.#locale = locale;
    this.#text = getMessages(locale).canvas;
    this.#renderer.setWinnerLabel(this.#text.winner);
    this.#refreshFonts();
  }

  /** Rebuilds the field, and the track itself when the seed or length change. */
  setRun(names: readonly string[], seed: string, track: TrackLength): void {
    const trackChanged = seed !== this.#seed || track !== this.#track;
    this.#names = names.slice(0, MAX_NAMES);
    this.#seed = seed;
    this.#track = track;

    if (trackChanged) this.#rebuildCourse();
    else this.#rebuildField();

    if (this.#phase !== 'idle') this.#setPhase('idle');
  }

  start(): void {
    if (!this.#alive || this.#names.length < 2) return;
    this.#sound.unlock();
    this.#rebuildField();
    this.#preview.flatten = 0;
    this.#preview.eye = undefined;
    this.#preview.lookAt = undefined;
    this.#previewAlpha = 1;
    this.#rideBlend = 0;
    this.#heading = { x: 0, y: 1 };
    this.#rideSeeded = false;
    this.#beginRecording();
    this.#camera.snap(COURSE.width / 2, COURSE.releaseY + 220, 1);
    this.#setPhase('preview');
  }

  reset(): void {
    if (!this.#alive) return;
    this.#stopRecording(false);
    this.#rideBlend = 0;
    this.#previewAlpha = 0;
    this.#renderer.setWorldVisible(true);
    this.#rebuildField();
    this.#camera.snap(COURSE.width / 2, COURSE.releaseY + 220, 1);
    this.#setPhase('idle');
  }

  destroy(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#unbindBoard();
    this.#recorder?.cancel();
    cancelAnimationFrame(this.#raf);
    this.#sound.dispose();
    this.#canvas.destroy();
  }

  /* ------------------------------------------------------------- editing */

  /**
   * Hands the board to a map editor, or takes it back when passed null.
   *
   * While an editor is attached the race machinery is parked: no physics runs,
   * the camera is driven by the pointer instead of the leader, and the board is
   * drawn straight from the editor's blueprint so a drag lands on screen in the
   * same frame it happens.
   */
  setEditor(editor: MapEditor | null): void {
    if (!this.#alive || this.#editor === editor) return;

    this.#editor = editor;
    this.#releaseGestures();
    // Whatever the fly around or the ride camera left behind is put back before
    // the board changes hands, in either direction.
    this.#previewAlpha = 0;
    this.#rideBlend = 0;
    this.#renderer.setWorldVisible(true);
    this.#renderer.setEditing(editor !== null);

    if (editor) {
      this.#stopRecording(false);
      if (this.#phase !== 'idle') this.#setPhase('idle');
      this.#camera.setZoomRange(EDIT_ZOOM.min, EDIT_ZOOM.max);
      this.#camera.snap(COURSE.width / 2, COURSE.releaseY + 320, 1);
      this.#bindBoard();
    } else {
      this.#unbindBoard();
      this.#camera.setZoomRange(ZOOM.min, ZOOM.max);
      this.#camera.snap(COURSE.width / 2, COURSE.releaseY + 220, 1);
    }
  }

  get editing(): boolean {
    return this.#editor !== null;
  }

  /**
   * Runs on a hand drawn map instead of the seeded generator. Passing null
   * hands the track back to `seed` and `track`.
   */
  setCustomMap(map: Blueprint | null): void {
    if (!this.#alive) return;
    // Compared by value: the editor hands over a fresh object every time it is
    // applied, and React re-runs the effect for reasons of its own. Rebuilding
    // the course for a map that has not changed is pure churn.
    const key = map ? blueprintSignature(map) : null;
    if (key === this.#customKey) return;

    this.#customKey = key;
    this.#custom = map ? cloneBlueprint(map) : null;
    this.#rebuildCourse();
    if (this.#phase !== 'idle') this.#setPhase('idle');
  }

  /** Moves the editor view to a depth down the track. */
  lookAt(y: number, zoom = this.#camera.zoom): void {
    if (!this.#editor) return;
    this.#camera.snap(this.#camera.x, y, zoom);
    this.#clampBoardCamera();
  }

  /** Steps the editor zoom, for the on screen controls. */
  zoomBy(factor: number): void {
    if (!this.#editor) return;
    this.#camera.snap(this.#camera.x, this.#camera.y, this.#camera.zoom * factor);
    this.#clampBoardCamera();
  }

  /** Where the editor view currently sits, so the panel can show it. */
  get boardView(): { y: number; zoom: number; height: number } {
    return { y: this.#camera.y, zoom: this.#camera.zoom, height: this.#course.height };
  }

  /* --------------------------------------------------------- board input */

  #bindBoard(): void {
    const element = this.#element;
    if (!element) return;
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', this.#onPointerDown);
    element.addEventListener('pointermove', this.#onPointerMove);
    element.addEventListener('pointerup', this.#onPointerUp);
    element.addEventListener('pointercancel', this.#onPointerUp);
    element.addEventListener('pointerleave', this.#onPointerLeave);
    element.addEventListener('wheel', this.#onWheel, { passive: false });
    element.addEventListener('contextmenu', this.#onContextMenu);
    element.addEventListener('dragover', this.#onDragOver);
    element.addEventListener('drop', this.#onDrop);
    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onBlur);
  }

  #unbindBoard(): void {
    const element = this.#element;
    if (element) {
      element.style.touchAction = '';
      element.style.cursor = '';
      element.removeEventListener('pointerdown', this.#onPointerDown);
      element.removeEventListener('pointermove', this.#onPointerMove);
      element.removeEventListener('pointerup', this.#onPointerUp);
      element.removeEventListener('pointercancel', this.#onPointerUp);
      element.removeEventListener('pointerleave', this.#onPointerLeave);
      element.removeEventListener('wheel', this.#onWheel);
      element.removeEventListener('contextmenu', this.#onContextMenu);
      element.removeEventListener('dragover', this.#onDragOver);
      element.removeEventListener('drop', this.#onDrop);
    }
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onBlur);
  }

  #releaseGestures(): void {
    this.#touches.clear();
    this.#pan = null;
    this.#pinch = null;
    this.#spaceHeld = false;
  }

  /** Canvas pixels per world unit at the current zoom. */
  get #scale(): number {
    return baseScale({ width: this.#width, height: this.#height }) * this.#camera.zoom;
  }

  /** Canvas space point for a pointer event, in the units the stage draws in. */
  #canvasPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const element = this.#element;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    // The element can be letterboxed inside its frame, so the CSS box is the
    // only reliable bridge between a client coordinate and a drawing one.
    return {
      x: (event.clientX - rect.left) * (this.#width / Math.max(rect.width, 1)),
      y: (event.clientY - rect.top) * (this.#height / Math.max(rect.height, 1)),
    };
  }

  #toWorld(event: PointerEvent | WheelEvent): PointerInput {
    const point = this.#canvasPoint(event);
    const scale = this.#scale;
    return {
      x: this.#camera.x + (point.x - this.#width / 2) / scale,
      y: this.#camera.y + (point.y - this.#height / 2) / scale,
      scale,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey || event.ctrlKey,
    };
  }

  #clampBoardCamera(): void {
    const editor = this.#editor;
    if (!editor) return;
    const view = this.#renderer.worldView;
    const halfWidth = view.width / this.#camera.zoom / 2;
    const halfHeight = view.height / this.#camera.zoom / 2;
    const minX = COURSE.left - 60 + halfWidth;
    const maxX = COURSE.right + 60 - halfWidth;
    const x = minX > maxX ? COURSE.width / 2 : clamp(this.#camera.x, minX, maxX);
    const y = clamp(this.#camera.y, -halfHeight, editor.courseHeight + halfHeight);
    this.#camera.snap(x, y, this.#camera.zoom);
  }

  #beginPan(event: PointerEvent): void {
    const point = this.#canvasPoint(event);
    this.#pan = { x: point.x, y: point.y, camX: this.#camera.x, camY: this.#camera.y };
  }

  #onPointerDown = (event: PointerEvent): void => {
    const editor = this.#editor;
    if (!editor) return;
    this.#element?.setPointerCapture?.(event.pointerId);
    const point = this.#canvasPoint(event);
    this.#touches.set(event.pointerId, point);

    // Two fingers is always a pan and zoom, whatever the first one was doing.
    if (this.#touches.size === 2) {
      editor.cancelDrag();
      this.#pinch = { distance: this.#touchSpread(), zoom: this.#camera.zoom };
      this.#beginPan(event);
      return;
    }

    // Middle button, right button or a held space bar all mean "move the view".
    if (event.button === 1 || event.button === 2 || this.#spaceHeld) {
      event.preventDefault();
      this.#beginPan(event);
      return;
    }
    if (event.button !== 0) return;

    event.preventDefault();
    editor.pointerDown(this.#toWorld(event));
  };

  #onPointerMove = (event: PointerEvent): void => {
    const editor = this.#editor;
    if (!editor) return;
    const point = this.#canvasPoint(event);
    if (this.#touches.has(event.pointerId)) this.#touches.set(event.pointerId, point);

    if (this.#pinch && this.#touches.size >= 2) {
      const spread = this.#touchSpread();
      if (spread > 0 && this.#pinch.distance > 0) {
        this.#camera.snap(this.#camera.x, this.#camera.y, this.#pinch.zoom * (spread / this.#pinch.distance));
      }
    }

    if (this.#pan) {
      const scale = this.#scale;
      this.#camera.snap(
        this.#pan.camX - (point.x - this.#pan.x) / scale,
        this.#pan.camY - (point.y - this.#pan.y) / scale,
        this.#camera.zoom,
      );
      this.#clampBoardCamera();
      return;
    }

    editor.pointerMove(this.#toWorld(event));
  };

  #onPointerUp = (event: PointerEvent): void => {
    const editor = this.#editor;
    this.#element?.releasePointerCapture?.(event.pointerId);
    this.#touches.delete(event.pointerId);
    if (this.#touches.size < 2) this.#pinch = null;

    if (this.#pan) {
      // A pan that ends still leaves the other finger down mid gesture, so the
      // editor is only handed back the board once every pointer has lifted.
      if (!this.#touches.size) this.#pan = null;
      return;
    }
    editor?.pointerUp(this.#toWorld(event));
  };

  #onPointerLeave = (): void => {
    this.#editor?.pointerLeave();
  };

  #onContextMenu = (event: MouseEvent): void => {
    // Right drag pans, so the browser menu would fire in the middle of it.
    if (this.#editor) event.preventDefault();
  };

  #touchSpread(): number {
    const points = [...this.#touches.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  #onWheel = (event: WheelEvent): void => {
    if (!this.#editor) return;
    event.preventDefault();

    if (event.ctrlKey || event.metaKey) {
      // Zoom about the pointer: the world point under the cursor stays put.
      const before = this.#toWorld(event);
      const factor = Math.exp(-event.deltaY * 0.0016);
      this.#camera.snap(this.#camera.x, this.#camera.y, this.#camera.zoom * factor);
      const after = this.#toWorld(event);
      this.#camera.snap(
        this.#camera.x + (before.x - after.x),
        this.#camera.y + (before.y - after.y),
        this.#camera.zoom,
      );
    } else {
      const scale = this.#scale;
      this.#camera.snap(this.#camera.x + event.deltaX / scale, this.#camera.y + event.deltaY / scale, this.#camera.zoom);
    }
    this.#clampBoardCamera();
  };

  #onKeyDown = (event: KeyboardEvent): void => {
    const editor = this.#editor;
    if (!editor) return;
    const target = event.target as HTMLElement | null;
    // Typing in the inspector must never nudge or delete the selection.
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;

    if (event.code === 'Space') {
      this.#spaceHeld = true;
      event.preventDefault();
      return;
    }
    if (editor.keyDown(event)) event.preventDefault();
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') this.#spaceHeld = false;
  };

  #onBlur = (): void => {
    this.#releaseGestures();
  };

  #onDragOver = (event: DragEvent): void => {
    if (!this.#editor || !event.dataTransfer) return;
    // Without this the browser navigates to the file instead of handing it over.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  /**
   * Artwork dropped on the board becomes scenery at the point it landed.
   *
   * The world position is taken before the files are read, because reading is
   * async and the camera may well have moved by the time the bytes arrive.
   */
  #onDrop = (event: DragEvent): void => {
    const editor = this.#editor;
    if (!editor) return;
    event.preventDefault();

    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;

    const point = this.#canvasPoint(event);
    const scale = this.#scale;
    const x = this.#camera.x + (point.x - this.#width / 2) / scale;
    const y = this.#camera.y + (point.y - this.#height / 2) / scale;

    void this.#dropArtwork(files, x, y);
  };

  async #dropArtwork(files: File[], x: number, y: number): Promise<void> {
    const art: Array<{ skin: Skin; width: number; height: number }> = [];
    let note: SkinError | null = null;

    for (const file of files) {
      const result = await readSkinFile(file);
      if ('error' in result) {
        note = result.error;
        continue;
      }
      const size = await artworkSize(result.skin);
      art.push({ skin: result.skin, width: size.width, height: size.height });
    }

    // The editor can have been closed while the files were being read.
    const editor = this.#editor;
    if (!this.#alive || !editor) return;

    editor.setNote(note);
    editor.addDecals(art, x, y);
  }

  #buildCourse(): Course {
    return this.#custom ? compile(this.#custom) : createCourse(hashSeed(this.#seed), TRACK_LENGTHS[this.#track]);
  }

  #rebuildCourse(): void {
    this.#course = this.#buildCourse();
    this.#renderer.setCourse(this.#course);
    const view = this.#renderer.worldView;
    this.#camera.setView(view.width, view.height);
    this.#rebuildField();
  }

  #rebuildField(): void {
    this.#sim = new Simulation(this.#course, this.#names, hashSeed(`${this.#seed}:${this.#names.join('|')}`));
    this.#sim.updateStandings();
    this.#announced = 0;
    this.#fx = new Fx(mulberry32(hashSeed(this.#seed) ^ 0x5bf03635));
    this.#accumulator = 0;
    this.#finishEnergy = 0;
    this.#revealTime = 0;
    this.#marks = { waves: 0, confetti: false, sides: false, sparkle: 0 };
    this.#banner = null;
    this.#leaderIndex = -1;
    this.#finalCalled = false;
    this.#refreshFonts();
    this.#renderer.configureRun(this.#sim.marbles, this.#fontFor, (name) => this.#skins[name]);
  }

  /** Pulls in the CJK face when a name or the interface needs it. */
  #refreshFonts(): void {
    if (this.#cjkReady) return;
    if (!needsCjk(this.#names) && !needsCjkFont(this.#locale)) return;
    void loadFont(this.#tvg, CJK_FONT).then((ok) => {
      if (!ok || !this.#alive) return;
      this.#cjkReady = true;
      this.#rebindFonts();
    });
  }

  /** Rebuilds the font resolver from whatever is currently loaded. */
  #rebindFonts(): void {
    this.#fontFor = fontResolver(this.#cjkReady);
    this.#renderer.configureRun(this.#sim.marbles, this.#fontFor, (name) => this.#skins[name]);
  }

  /** Renders a still of a Lottie skin's first frame, for the roster chip. */
  thumbnail(skin: Skin): string | null {
    if (!this.#alive) return null;
    return renderLottieThumb(this.#tvg, this.#backend, skin);
  }

  setSound(enabled: boolean): void {
    this.#sound.setEnabled(enabled);
  }

  /** Hands over the artwork each marble carries. */
  setSkins(skins: Record<string, Skin>): void {
    if (!this.#alive) return;
    this.#skins = skins;
    this.#renderer.configureRun(this.#sim.marbles, this.#fontFor, (name) => this.#skins[name]);
  }

  #beginRecording(): void {
    if (!this.#recordEnabled || !this.#recorder || this.#recorder.recording) return;
    this.#recordArmed = this.#recorder.start();
    if (!this.#recordArmed) return;

    this.#lockedSize = { width: this.#width, height: this.#height };
    this.#callbacks.onRecording?.('recording');
  }

  /** @param keep true hands the file over, false throws the take away */
  #stopRecording(keep: boolean): void {
    if (!this.#recorder || !this.#recordArmed) return;
    this.#recordArmed = false;

    if (!keep) {
      this.#recorder.cancel();
      this.#unlockSize();
      this.#callbacks.onRecording?.('idle');
      return;
    }

    this.#callbacks.onRecording?.('saving');
    this.#unlockSize();
    void this.#recorder.stop().then((video) => {
      this.#callbacks.onRecording?.('idle');
      if (video) this.#callbacks.onVideo?.(video);
    });
  }

  #setPhase(phase: Phase): void {
    this.#phase = phase;
    this.#phaseTime = 0;
    this.#countBeat = 0;
    this.#callbacks.onPhase?.(phase);
  }

  #raise(text: string, sub: string, color: RGB): void {
    this.#banner = { text, sub, color, t: 0 };
  }

  #loop = (now: number): void => {
    if (!this.#alive) return;
    this.#raf = requestAnimationFrame(this.#loop);

    const dt = Math.min(0.05, this.#last ? (now - this.#last) / 1000 : 0.016);
    this.#last = now;
    this.#time += dt;
    this.#phaseTime += dt;

    this.#advance(dt);
    this.#draw(dt);
    this.#recorder?.frame();
  };

  #advance(dt: number): void {
    const sim = this.#sim;

    // The editor owns the board: nothing simulates, and the camera answers to
    // the pointer rather than to the field.
    if (this.#editor) {
      this.#fx.update(dt);
      return;
    }

    switch (this.#phase) {
      case 'idle':
      case 'countdown': {
        for (const marble of sim.marbles) {
          marble.y = COURSE.releaseY + Math.sin(this.#time * 1.9 + marble.index * 0.55) * 3.5;
        }
        sim.sampleTrails();

        // Riding: the countdown is watched from the seat, still in perspective.
        if (this.#phase === 'countdown' && this.#view === 'ride') {
          driveObstacles(this.#course, this.#time);
          this.#rideBlend = 1;
          this.#driveRideCamera(dt);
          this.#previewAlpha = 1;
          this.#renderer.setWorldVisible(false);
        } else {
          this.#camera.aim(
            COURSE.width / 2,
            COURSE.releaseY + 220 + Math.sin(this.#time * 0.6) * 12,
            this.#phase === 'countdown' ? 1.12 : 1,
          );
        }

        if (this.#phase === 'countdown') {
          // One beep for each number as it comes up.
          const beat = Math.ceil(((COUNTDOWN - this.#phaseTime) / COUNTDOWN) * 3);
          if (beat !== this.#countBeat && beat >= 1) {
            this.#countBeat = beat;
            this.#sound.count();
          }
          if (this.#phaseTime >= COUNTDOWN) this.#release();
        }
        break;
      }

      case 'preview': {
        for (const marble of sim.marbles) marble.y = COURSE.releaseY;
        // Keep the machinery turning so the fly around has something to show.
        driveObstacles(this.#course, this.#time);
        this.#flyOver(dt);
        if (this.#phaseTime >= PREVIEW) {
          this.#previewAlpha = 0;
          this.#renderer.setWorldVisible(true);
          this.#setPhase('countdown');
        }
        break;
      }

      case 'racing':
      case 'reveal': {
        const slowmo = this.#phase === 'reveal' ? 1 - 0.85 * Math.min(1, this.#revealTime / 0.6) : 1;
        const tail = this.#phase !== 'reveal' || this.#revealTime < REVEAL_SIM_TAIL;

        if (tail) {
          this.#accumulator = Math.min(this.#accumulator + dt * this.#speed * slowmo, 0.25);
          while (this.#accumulator >= FIXED_DT) {
            sim.step();
            this.#accumulator -= FIXED_DT;
            if (sim.winner && this.#phase === 'racing' && this.#mode === 'winner') break;
          }
        }

        this.#drainImpacts();
        if (this.#phase === 'racing') this.#boostSounds();
        sim.sampleTrails();
        sim.updateStandings();

        // Ride camera dives into the board when racing and pulls back out for
        // the reveal, morphing through the flat view either way.
        if (this.#view === 'ride') {
          const target = this.#phase === 'racing' ? 1 : 0;
          // Coming out of the preview the seat is already taken.
          const rate = target > this.#rideBlend ? dt / 0.6 : dt / 0.5;
          this.#rideBlend = clamp(this.#rideBlend + (target > this.#rideBlend ? rate : -rate), 0, 1);
          this.#driveRideCamera(dt);
          this.#previewAlpha = clamp(this.#rideBlend * 4, 0, 1);
          this.#renderer.setWorldVisible(this.#previewAlpha < 0.98);
        }

        if (this.#phase === 'racing') {
          this.#raceEvents();
          this.#camera.follow(sim.standings, this.#course.finishY);
          if (this.#mode === 'ranking') {
            this.#callPlaces();
            // Everyone in, or the tail has had long enough after the winner.
            const waited = sim.winner ? sim.time - sim.winTime : 0;
            if (sim.finishedCount >= sim.marbles.length || waited > RANKING_TAIL) this.#declare();
          } else if (sim.winner) {
            this.#declare();
          }
        } else {
          const winner = sim.winner;
          if (winner) this.#camera.aim(winner.x, this.#course.finishY + 40, 1.5);
        }
        break;
      }
    }

    sim.decay(dt);
    this.#fx.update(dt);
    this.#finishEnergy = Math.max(0, this.#finishEnergy - dt * 1.7);

    if (this.#banner) {
      this.#banner.t += dt;
      if (this.#banner.t > BANNER_LIFE) this.#banner = null;
    }

    if (this.#phase === 'reveal') {
      this.#revealTime += dt;
      this.#runRevealMarks();
      if (this.#recordArmed && this.#revealTime > 4.4) this.#stopRecording(true);
    }
  }

  /**
   * Pre race fly around. The course is shown in perspective, the camera orbits
   * while it travels the length of the track, then the whole scene flattens
   * into the 2D board the race is actually played on.
   */
  #flyOver(dt: number): void {
    const t = this.#phaseTime;
    const riding = this.#view === 'ride';
    const start = COURSE.releaseY + 320;
    const end = this.#course.finishY - 120;
    const pose = this.#preview;

    if (t < 1.0) {
      // Establishing shot over the start line.
      const p = easeOutCubic(clamp(t / 1.0, 0, 1));
      pose.targetY = start;
      pose.distance = lerp(2400, 1550, p);
      pose.yaw = lerp(-0.62, -0.26, p);
      pose.pitch = lerp(0.42, 0.52, p);
    } else if (t < 3.0) {
      // Travel the length of the course, swinging around it on the way.
      const p = easeInOutCubic(clamp((t - 1.0) / 2.0, 0, 1));
      pose.targetY = lerp(start, end, p);
      pose.distance = lerp(1550, 1850, Math.sin(p * Math.PI));
      pose.yaw = lerp(-0.26, 0.44, p);
      pose.pitch = lerp(0.52, 0.66, p);
    } else if (t < FLATTEN_AT) {
      const p = easeInOutCubic(clamp((t - 3.0) / (FLATTEN_AT - 3.0), 0, 1));
      pose.targetY = lerp(end, start, p);
      pose.distance = lerp(1850, 1500, p);
      pose.yaw = lerp(0.44, 0.16, p);
      pose.pitch = lerp(0.66, 0.72, p);
    } else if (riding) {
      // Ride start: stay in perspective and fly straight into the seat behind
      // the marble, so the run never passes through the flat board.
      const p = easeInOutCubic(clamp((t - FLATTEN_AT) / (PREVIEW - FLATTEN_AT), 0, 1));
      pose.targetY = start;
      pose.distance = lerp(1500, 900, p);
      pose.yaw = lerp(0.16, 0, p);
      pose.pitch = lerp(0.72, 0.5, p);
      pose.flatten = 0;

      this.#driveRideCamera(dt);
      const seatEye = this.#ride.eye;
      const seatLook = this.#ride.lookAt;
      if (seatEye && seatLook) {
        const orbit = orbitEye(pose);
        pose.eye = mixVec(orbit, seatEye, p);
        pose.lookAt = mixVec({ x: pose.targetX, y: pose.targetY, z: 0 }, seatLook, p);
      }
    } else {
      // Rotate overhead and drop onto the flat board.
      const p = easeInOutCubic(clamp((t - FLATTEN_AT) / (PREVIEW - FLATTEN_AT), 0, 1));
      pose.targetY = start;
      pose.distance = lerp(1500, 1250, p);
      pose.yaw = lerp(0.16, 0, p);
      pose.pitch = lerp(0.72, Math.PI / 2, p);
      pose.flatten = p;
    }

    if (t < FLATTEN_AT) {
      pose.flatten = 0;
      pose.eye = undefined;
      pose.lookAt = undefined;
    }
    pose.targetX = COURSE.width / 2;

    // The flat camera stays parked on the release line, so the board handover
    // lands exactly where the countdown begins.
    this.#camera.snap(COURSE.width / 2, COURSE.releaseY + 220, 1);

    if (riding) {
      this.#previewAlpha = 1;
      this.#renderer.setWorldVisible(false);
      return;
    }

    // Hand over: the board fades in under the preview, then the preview goes.
    const handover = span(pose.flatten, 0.62, 1);
    this.#previewAlpha = 1 - handover;
    this.#renderer.setWorldVisible(pose.flatten > 0.62);
  }

  /** The marble the ride camera is strapped to. */
  #rideSubject(): Marble | null {
    const sim = this.#sim;
    if (this.#follow === 'leader') return sim.standings.find((m) => !m.finished) ?? sim.standings[0] ?? null;
    return sim.marbles[this.#follow] ?? null;
  }

  /**
   * Chase camera sitting just behind and above the marble. The heading is
   * smoothed and biased down the course, otherwise every bounce would whip the
   * view around.
   */
  #driveRideCamera(dt: number): void {
    const marble = this.#rideSubject();
    if (!marble) return;

    const speed = Math.hypot(marble.vx, marble.vy);
    const dirX = speed > 40 ? marble.vx / speed : 0;
    const dirY = speed > 40 ? marble.vy / speed : 1;

    const k = 1 - Math.exp(-3.2 * dt);
    this.#heading.x = lerp(this.#heading.x, dirX * 0.55, k);
    this.#heading.y = lerp(this.#heading.y, Math.max(0.4, dirY), k);

    const len = Math.hypot(this.#heading.x, this.#heading.y) || 1;
    const hx = this.#heading.x / len;
    const hy = this.#heading.y / len;

    // Chase camera: far enough back that the marble reads as a runner on the
    // track rather than filling the frame, with a little lag on the follow.
    if (!this.#rideSeeded) {
      this.#rideEye = { x: marble.x, y: marble.y };
      this.#rideSeeded = true;
    }
    const follow = 1 - Math.exp(-9 * dt);
    this.#rideEye.x = lerp(this.#rideEye.x, marble.x, follow);
    this.#rideEye.y = lerp(this.#rideEye.y, marble.y, follow);

    const back = 370;
    const lift = 148;
    const ahead = 250;

    this.#ride.eye = {
      x: clamp(this.#rideEye.x - hx * back, COURSE.left - 140, COURSE.right + 140),
      y: this.#rideEye.y - hy * back,
      z: lift,
    };
    this.#ride.lookAt = { x: marble.x + hx * ahead, y: marble.y + hy * ahead, z: 18 };
    this.#ride.targetX = marble.x;
    this.#ride.targetY = marble.y;
    this.#ride.behind = 900;
    this.#ride.flatten = 1 - this.#rideBlend;
  }

  #release(): void {
    this.#setPhase('racing');
    this.#raise(this.#text.go, '', UI.text);
    this.#sound.go();
    this.#boosting.clear();
    this.#camera.kick(0.4);
    for (const marble of this.#sim.marbles) {
      marble.trail.length = 0;
      this.#fx.impact(marble.x, marble.y + marble.r, 0, 1, 0.5, marble.color, false);
    }
  }

  #drainImpacts(): void {
    const impacts = this.#sim.impacts;
    const leader = this.#sim.standings[0];

    for (const hit of impacts) {
      this.#fx.impact(hit.x, hit.y, hit.nx, hit.ny, hit.strength, hit.color, hit.bumper);
      const loudness = this.#phase === 'racing' ? this.#loudnessAt(hit.y) : 0;
      if (loudness > 0) this.#sound.impact(hit.strength * loudness, hit.bumper, this.#panAt(hit.x));
      // Heavy hits near the front of the field rattle the camera.
      if (hit.bumper && hit.strength > 0.65 && leader && Math.abs(hit.y - leader.y) < 260) {
        this.#camera.kick(hit.strength * 0.16);
      }
    }
    impacts.length = 0;
  }

  /** How much of a sound at this height reaches the viewer: 1 on screen, 0 far off it. */
  #loudnessAt(y: number): number {
    const reach = this.#camera.viewHeight * 0.5;
    const away = Math.abs(y - this.#camera.y);
    return clamp(1.25 - away / (reach * 1.6), 0, 1);
  }

  #panAt(x: number): number {
    return ((x - COURSE.width / 2) / (COURSE.width / 2)) * 0.7;
  }

  /** A marble rolling onto a pad is heard once, not once per step it stays there. */
  #boostSounds(): void {
    for (const marble of this.#sim.marbles) {
      if (marble.boost <= 0) {
        this.#boosting.delete(marble.index);
        continue;
      }
      if (this.#boosting.has(marble.index)) continue;
      this.#boosting.add(marble.index);
      if (this.#loudnessAt(marble.y) > 0.2) this.#sound.boost(this.#panAt(marble.x));
    }
  }

  /** Lead changes, the run home, and the live standings feed for the page. */
  #raceEvents(): void {
    const sim = this.#sim;
    const leader = sim.standings[0];
    if (!leader) return;

    if (this.#leaderIndex === -1) {
      this.#leaderIndex = leader.index;
    } else if (
      leader.index !== this.#leaderIndex &&
      this.#phaseTime > 1.6 &&
      this.#time - this.#lastLeadChange > 3.4
    ) {
      this.#leaderIndex = leader.index;
      this.#lastLeadChange = this.#time;
      this.#raise(this.#text.leadChange, this.#text.leadChangeSub(leader.name), leader.color);
      this.#sound.leadChange();
      this.#camera.kick(0.3);
      this.#camera.punch(0.16);
    }

    if (!this.#finalCalled && leader.best > this.#course.finishY - 900) {
      this.#finalCalled = true;
      this.#raise(this.#text.finalStretch, this.#text.finalStretchSub, UI.gold);
      this.#sound.finalStretch();
      this.#camera.punch(0.2);
    }
  }

  /**
   * In a ranking run every crossing is worth calling, not just the first, so
   * each new finisher raises a banner with the place they took.
   */
  #callPlaces(): void {
    const sim = this.#sim;
    if (sim.finishedCount <= this.#announced) return;

    // Standings put the finishers first, in the order they came in.
    for (let place = this.#announced + 1; place <= sim.finishedCount; place++) {
      const marble = sim.standings[place - 1];
      if (!marble) continue;
      // The winner gets the finish banner from #declare, not a place call.
      if (place > 1) {
        this.#raise(this.#text.placed(place), marble.name, marble.color);
        this.#sound.placed();
      }
    }
    this.#announced = sim.finishedCount;
  }

  /** The field in finishing order, with anyone still out ranked by depth. */
  #ranking(): RankEntry[] {
    return this.#sim.standings.map((marble, i) => ({
      place: i + 1,
      index: marble.index,
      name: marble.name,
      color: marble.color,
      elapsed: marble.finished ? marble.finishTime : null,
    }));
  }

  #declare(): void {
    const winner = this.#sim.winner;
    if (!winner) return;

    const chaser = this.#sim.standings.find((m) => m !== winner);
    const margin = chaser ? Math.max(0, winner.best - chaser.best) : 0;
    const photo = margin < 150;

    this.#setPhase('reveal');
    this.#revealTime = 0;
    this.#finishEnergy = 1;
    this.#camera.kick(0.6);
    this.#raise(photo ? this.#text.photoFinish : this.#text.finish, winner.name, winner.color);
    this.#sound.finish();
    this.#renderer.beginReveal(
      winner,
      { x: winner.x, y: winner.y },
      this.#fontFor,
      this.#skins[winner.name],
      this.#mode === 'ranking' ? this.#ranking() : [],
    );
    this.#callbacks.onWinner?.({
      index: winner.index,
      name: winner.name,
      color: winner.color,
      elapsed: this.#sim.winTime,
      margin,
      photoFinish: photo,
      ranking: this.#mode === 'ranking' ? this.#ranking() : [this.#ranking()[0]].filter(Boolean),
    });
  }

  /** Timed flourishes hung off the reveal clock. */
  #runRevealMarks(): void {
    const t = this.#revealTime;
    const winner = this.#sim.winner;
    const color = winner ? winner.color : UI.gold;
    const goal = { x: winner ? winner.x : this.#course.goal.x, y: this.#course.finishY };
    const waveTimes = [0, 0.14, 0.3];

    while (this.#marks.waves < waveTimes.length && t >= waveTimes[this.#marks.waves]) {
      const step = this.#marks.waves;
      this.#fx.shockwave(goal.x, goal.y, step === 1 ? UI.goal : color, {
        r: 12 + step * 10,
        vr: 1000 - step * 180,
        width: 9 - step * 2,
        life: 0.9 + step * 0.15,
      });
      this.#marks.waves++;
    }

    const palette: RGB[] = winner
      ? [winner.color, MARBLE_COLORS[2], MARBLE_COLORS[7], MARBLE_COLORS[10], UI.gold, [255, 255, 255]]
      : [...MARBLE_COLORS.slice(0, 6)];

    if (!this.#marks.confetti && t >= 0.95) {
      this.#marks.confetti = true;
      this.#fx.confettiBurst(380, 470, palette, 130);
    }

    if (!this.#marks.sides && t >= 1.45) {
      this.#marks.sides = true;
      this.#fx.confettiBurst(80, 1030, palette, 55, 0.9);
      this.#fx.confettiBurst(680, 1030, palette, 55, 0.9);
    }

    const sparkleStep = Math.floor((t - 1.0) / 0.28);
    if (t >= 1.0 && t <= 3.6 && sparkleStep > this.#marks.sparkle) {
      this.#marks.sparkle = sparkleStep;
      this.#fx.sparkleBurst(380, 404, 165, 3, sparkleStep % 2 ? UI.gold : [255, 255, 255]);
    }
  }

  #draw(dt: number): void {
    const sim = this.#sim;
    const camera = this.#camera.update(dt);
    const editor = this.#editor;

    if (editor && this.#element) {
      const cursor = this.#pan ? 'grabbing' : this.#spaceHeld ? 'grab' : editor.cursor;
      if (this.#element.style.cursor !== cursor) this.#element.style.cursor = cursor;
    }
    // The leader marker only makes sense once they are actually racing.
    const racing = this.#phase === 'racing' || this.#phase === 'reveal';
    const leader = racing ? sim.standings[0] ?? null : null;

    let countdown: number | null = null;
    if (this.#phase === 'countdown') countdown = Math.max(0, COUNTDOWN - this.#phaseTime) / (COUNTDOWN / 3);

    let hint: string | null = null;
    if (this.#phase === 'idle') hint = this.#names.length ? this.#text.ready : this.#text.addRunners;
    else if (this.#phase === 'preview') hint = this.#text.preview;

    this.#renderer.draw({
      preview:
        this.#previewAlpha > 0
          ? {
              pose: this.#phase === 'preview' ? this.#preview : this.#ride,
              marbles: sim.marbles,
              alpha: this.#previewAlpha,
              hideMarble: -1,
              time: this.#time,
            }
          : null,
      hideTag: this.#view === 'ride' && this.#rideBlend > 0.2,
      followIndex: this.#view === 'ride' ? (this.#rideSubject()?.index ?? -1) : -1,
      time: this.#time,
      dt,
      phase: this.#phase,
      camera,
      marbles: sim.marbles,
      standings: sim.standings,
      leader,
      fx: this.#fx,
      hiddenMarble: this.#phase === 'reveal' && sim.winner ? sim.winner.index : -1,
      hideStandings: this.#phase === 'reveal' && this.#mode === 'ranking',
      finishEnergy: this.#finishEnergy,
      countdown,
      countdownGo: this.#text.go,
      banner: this.#banner,
      hint,
      fontFor: this.#fontFor,
      revealTime: this.#phase === 'reveal' ? this.#revealTime : null,
      editor: editor ? editor.frame() : null,
    });
  }
}

export type { Marble, TrackLength };
