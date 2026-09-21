/** Composes the layer scenes and drives them from a single frame description. */

import type { Canvas, Scene, ThorVGNamespace } from '@thorvg/webcanvas';
import type { CameraView } from '../camera';
import type { FontResolver } from '../fonts';
import type { Fx } from '../fx';
import type { Skin } from '../skins';
import type { Course, Marble, Phase, RankEntry, Vec2 } from '../types';
import type { EditorFrame } from '../mapEditor';
import { Backdrop } from './backdrop';
import { CourseLayer } from './courseLayer';
import { DecalLayer } from './decalLayer';
import { EditorLayer } from './editorLayer';
import { HudLayer, type Banner } from './hud';
import { MarbleLayer } from './marbles';
import { ObstacleLayer } from './obstacles';
import { ParticleLayer } from './particles';
import { PreviewLayer, type PreviewFrame } from './previewLayer';
import { RevealLayer } from './reveal';
import { applyView, baseScale, cameraView, fitView, screenView, type View, type Viewport } from './common';

export interface Frame {
  /** Wall clock seconds since the stage started. */
  time: number;
  dt: number;
  phase: Phase;
  camera: CameraView;
  marbles: readonly Marble[];
  standings: readonly Marble[];
  leader: Marble | null;
  fx: Fx;
  /** Marble index taken over by the reveal, or -1. */
  hiddenMarble: number;
  /** Set when the reveal shows its own results board. */
  hideStandings?: boolean;
  finishEnergy: number;
  /** 3D fly around, drawn instead of the flat board before the countdown. */
  preview: Omit<PreviewFrame, 'viewport' | 'flat'> | null;
  countdown: number | null;
  countdownGo: string;
  banner: Banner | null;
  hint: string | null;
  /** The leader tag is projected with the flat view, so it hides in ride mode. */
  hideTag: boolean;
  /** Marble the camera is riding, marked in the standings. */
  followIndex: number;
  fontFor: FontResolver;
  revealTime: number | null;
  /** Set while the map editor owns the board, which replaces the race layers. */
  editor: EditorFrame | null;
}

export class Renderer {
  #canvas: Canvas;
  #course: Course;
  #viewport: Viewport = { width: 1, height: 1 };

  #parallaxScene: Scene;
  #worldScenes: Scene[] = [];
  #screenScenes: Scene[] = [];
  #fitScenes: Scene[] = [];
  /** The race content, hidden while the editor draws the board instead. */
  #raceScenes: Scene[] = [];
  #editScene: Scene;
  #hudScene: Scene;

  #backdrop: Backdrop;
  #track: CourseLayer;
  #obstacles: ObstacleLayer;
  #marbles: MarbleLayer;
  #particles: ParticleLayer;
  #hud: HudLayer;
  #reveal: RevealLayer;
  #preview: PreviewLayer;
  #editorLayer: EditorLayer;
  #decals: DecalLayer;
  #editing = false;
  #worldVisible = true;
  #world: View = { scale: 1, ox: 0, oy: 0 };

  constructor(tvg: ThorVGNamespace, canvas: Canvas, course: Course, latinFont: string) {
    this.#canvas = canvas;
    this.#course = course;

    const layer = (...buckets: Scene[][]) => {
      const scene = new tvg.Scene();
      canvas.add(scene);
      for (const bucket of buckets) bucket.push(scene);
      return scene;
    };

    const skyScene = layer(this.#screenScenes);
    this.#parallaxScene = layer();

    const decalScene = layer(this.#worldScenes);
    const trackScene = layer(this.#worldScenes, this.#raceScenes);
    const trackLive = layer(this.#worldScenes, this.#raceScenes);
    const obstacleScene = layer(this.#worldScenes, this.#raceScenes);
    const trailScene = layer(this.#worldScenes, this.#raceScenes);
    const marbleScene = layer(this.#worldScenes, this.#raceScenes);
    const sparkScene = layer(this.#worldScenes, this.#raceScenes);
    const editScene = layer(this.#worldScenes);
    const previewScene = layer(this.#screenScenes);
    const hudScene = layer(this.#screenScenes);
    const dimScene = layer(this.#fitScenes);
    const revealScene = layer(this.#fitScenes);
    const celebrationScene = layer(this.#fitScenes);

    this.#backdrop = new Backdrop(tvg, skyScene, this.#parallaxScene, course.height);
    this.#decals = new DecalLayer(tvg, decalScene);
    this.#track = new CourseLayer(tvg, trackScene, trackLive, course);
    this.#obstacles = new ObstacleLayer(tvg, obstacleScene);
    this.#marbles = new MarbleLayer(tvg, trailScene, marbleScene);
    this.#particles = new ParticleLayer(tvg, sparkScene, celebrationScene);
    this.#preview = new PreviewLayer(tvg, previewScene, course);
    this.#editorLayer = new EditorLayer(tvg, editScene);
    this.#editScene = editScene;
    this.#hudScene = hudScene;
    this.#hud = new HudLayer(tvg, hudScene, latinFont);
    this.#reveal = new RevealLayer(tvg, dimScene, revealScene, latinFont);
  }

  /** @param width/height CSS pixel size of the canvas element */
  layout(width: number, height: number): void {
    this.#viewport = { width, height };
    this.#backdrop.layout(this.#viewport);

    const screen = screenView();
    for (const scene of this.#screenScenes) applyView(scene, screen);

    const fit = fitView(this.#viewport);
    for (const scene of this.#fitScenes) applyView(scene, fit);
  }

  /** Visible world box at zoom 1, which the camera needs to frame the field. */
  get worldView(): { width: number; height: number } {
    const scale = baseScale(this.#viewport) || 1;
    return { width: this.#viewport.width / scale, height: this.#viewport.height / scale };
  }

  /** Caption used by the winner reveal. */
  setWinnerLabel(text: string): void {
    this.#reveal.setLabel(text);
  }

  configureRun(marbles: readonly Marble[], fontFor: FontResolver, skinFor: (name: string) => Skin | undefined): void {
    this.#marbles.configure(marbles, fontFor, skinFor);
    this.#preview.configureSkins(marbles, skinFor);
    this.#reveal.hide();
  }

  /** Takes a world position and hands the reveal its own letterboxed coordinates. */
  beginReveal(winner: Marble, worldPos: Vec2, fontFor: FontResolver, skin?: Skin, ranking: RankEntry[] = []): void {
    const world = this.#world;
    const fit = fitView(this.#viewport);
    const from = {
      x: (worldPos.x * world.scale + world.ox - fit.ox) / fit.scale,
      y: (worldPos.y * world.scale + world.oy - fit.oy) / fit.scale,
    };
    this.#reveal.configure(winner, from, (winner.r * world.scale) / fit.scale, fontFor, skin, ranking);
  }

  /**
   * Hands the board to the map editor. The baked course, the marbles and the
   * race HUD step aside; the editor layer draws the map from the blueprint.
   */
  setEditing(editing: boolean): void {
    this.#editing = editing;
    for (const scene of this.#raceScenes) scene.opacity(editing ? 0 : 255);
    this.#hudScene.opacity(editing ? 0 : 255);
    this.#editScene.opacity(editing ? 255 : 0);
    // The 3D preview is a screen space layer, so it has to be emptied by hand
    // rather than hidden with the race scenes.
    if (editing) this.#preview.clear();
    else this.#editorLayer.clear();
    // Coming out of the editor the board is shown again, whatever the preview left.
    if (!editing && !this.#worldVisible) this.setWorldVisible(true);
  }

  /** Hides the flat board while the 3D preview owns the screen. */
  setWorldVisible(visible: boolean): void {
    if (visible === this.#worldVisible) return;
    this.#worldVisible = visible;
    for (const scene of this.#worldScenes) scene.opacity(visible ? 255 : 0);
    // The editor is never on during a preview, so it keeps its own visibility.
    if (this.#editing) this.setEditing(true);
  }

  /**
   * Points the renderer at a new course.
   *
   * Only the layers that bake geometry from it are rebuilt, and each swaps a
   * single child scene. Rebuilding the whole renderer instead would discard
   * every marble picture, Lottie animation and text paint on the canvas on
   * every edit, and leave their native lifetimes to the garbage collector.
   */
  setCourse(course: Course): void {
    this.#course = course;
    this.#track.setCourse(course);
    this.#backdrop.setCourse(course.height);
    this.#preview.setCourse(course);
    this.#reveal.hide();
  }

  draw(frame: Frame): void {
    const vp = this.#viewport;
    this.#world = cameraView(frame.camera, vp, 1);
    for (const scene of this.#worldScenes) applyView(scene, this.#world);
    applyView(this.#parallaxScene, cameraView(frame.camera, vp, 0.28));

    const viewHeight = vp.height / this.#world.scale;

    if (frame.preview) {
      this.#preview.update({ ...frame.preview, viewport: vp, flat: this.#world });
    } else {
      this.#preview.clear();
    }

    this.#backdrop.update(frame.time);
    // Scenery is drawn the same way in both modes: while the editor is open it
    // comes off the live blueprint, otherwise off the compiled course.
    this.#decals.update(frame.editor ? frame.editor.decals : this.#course.decals, frame.time);

    // The editor owns the board outright: the race layers are hidden, so
    // rebuilding them every frame would be work nobody would ever see.
    if (frame.editor) {
      this.#editorLayer.update(frame.editor, this.#world.scale, frame.camera.y, viewHeight);
      this.#reveal.hide();
      this.#canvas.update().render();
      return;
    }

    this.#track.update(frame.time, frame.finishEnergy);
    this.#obstacles.update(this.#course, frame.camera.y, viewHeight);
    this.#marbles.update(frame.marbles, frame.hiddenMarble, this.#course.height, frame.leader, frame.time);
    this.#particles.update(frame.fx);

    this.#hud.update(
      {
        phase: frame.phase,
        time: frame.time,
        viewport: vp,
        standings: frame.standings,
        hideStandings: frame.hideStandings,
        leader: frame.leader,
        finishY: this.#course.finishY,
        countdown: frame.countdown,
        countdownGo: frame.countdownGo,
        banner: frame.banner,
        hint: frame.hint,
        hideTag: frame.hideTag,
        followIndex: frame.followIndex,
        fontFor: frame.fontFor,
        project: (x, y) => ({ x: x * this.#world.scale + this.#world.ox, y: y * this.#world.scale + this.#world.oy }),
      },
      frame.dt,
    );

    if (frame.revealTime === null) this.#reveal.hide();
    else this.#reveal.update(frame.revealTime);

    this.#canvas.update().render();
  }
}
