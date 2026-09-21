'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { RendererType } from '@thorvg/webcanvas';
import wasmUrl from '../node_modules/@thorvg/webcanvas/dist/thorvg.wasm';
import type { TrackLength } from '../lib/course';
import type { Blueprint } from '../lib/blueprint';
import type { Locale, Messages } from '../lib/i18n';
import type { MapEditor } from '../lib/mapEditor';
import type { RecordedVideo } from '../lib/recorder';
import { Stage, type FollowTarget, type RecordingState, type ViewMode, type WinnerInfo } from '../lib/stage';
import type { Skin } from '../lib/skins';
import type { Phase, RaceMode } from '../lib/types';

const CANVAS_ID = 'race-canvas';

export interface StageHandle {
  start: () => void;
  reset: () => void;
  /** Still of a Lottie skin's first frame, once the engine is up. */
  thumbnail: (skin: Skin) => string | null;
  /** Editor view controls, driven by the map editor panel. */
  zoomBy: (factor: number) => void;
  lookAt: (y: number) => void;
}

interface RaceStageProps {
  names: string[];
  seed: string;
  speed: number;
  mode: RaceMode;
  track: TrackLength;
  renderer: RendererType;
  locale: Locale;
  messages: Messages;
  phase: Phase;
  canStart: boolean;
  /** False until the URL has been read, so the engine is only built once. */
  hydrated: boolean;
  view: ViewMode;
  follow: FollowTarget;
  /** Marble artwork, keyed by runner name. */
  skins: Record<string, Skin>;
  record: boolean;
  sound: boolean;
  /** Attached while the map editor owns the board. */
  editor: MapEditor | null;
  /** A hand drawn map to race on, or null for the seeded generator. */
  customMap: Blueprint | null;
  onStart: () => void;
  onReset: () => void;
  onPhase: (phase: Phase) => void;
  onWinner: (winner: WinnerInfo) => void;
  onVideo: (video: RecordedVideo) => void;
}

const RaceStage = forwardRef<StageHandle, RaceStageProps>(function RaceStage(
  {
    names,
    seed,
    speed,
    mode,
    track,
    renderer,
    locale,
    messages,
    phase,
    canStart,
    hydrated,
    view,
    follow,
    skins,
    record,
    sound,
    editor,
    customMap,
    onStart,
    onReset,
    onPhase,
    onWinner,
    onVideo,
  },
  ref,
) {
  const t = messages.stage;
  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const latest = useRef({ names, seed, speed, mode, track, locale, record, view, follow, skins, sound, phase, editor, customMap, onStart, onReset, onPhase, onWinner, onVideo });
  latest.current = { names, seed, speed, mode, track, locale, record, view, follow, skins, sound, phase, editor, customMap, onStart, onReset, onPhase, onWinner, onVideo };

  const [measured, setMeasured] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** iOS Safari has no element fullscreen, so the control is hidden there. */
  const [canFullscreen, setCanFullscreen] = useState(true);
  const [recording, setRecording] = useState<RecordingState>('idle');
  /** True while the canvas is smaller than its frame, ie. pinned for a take. */
  const [pinned, setPinned] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      start: () => stageRef.current?.start(),
      reset: () => stageRef.current?.reset(),
      thumbnail: (skin: Skin) => stageRef.current?.thumbnail(skin) ?? null,
      zoomBy: (factor: number) => stageRef.current?.zoomBy(factor),
      lookAt: (y: number) => stageRef.current?.lookAt(y),
    }),
    [],
  );

  // Track the drawing area and keep the canvas in sync with it.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const canvas = document.getElementById(CANVAS_ID);

    const measurePinned = () => {
      const element = document.getElementById(CANVAS_ID);
      if (!element) return;
      setPinned(box.clientWidth - element.clientWidth > 2 || box.clientHeight - element.clientHeight > 2);
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((item) => item.target === box);
      if (entry) {
        const width = Math.round(entry.contentRect.width);
        const height = Math.round(entry.contentRect.height);
        if (width >= 2 && height >= 2) {
          sizeRef.current = { width, height };
          stageRef.current?.resize(width, height);
          setMeasured(true);
        }
      }
      measurePinned();
    });

    observer.observe(box);
    if (canvas) observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Build the engine once, after the size is known and the URL has been read.
  useEffect(() => {
    if (!measured || !hydrated) return;

    let cancelled = false;
    let created: Stage | null = null;

    Stage.create(
      {
        selector: `#${CANVAS_ID}`,
        renderer,
        wasmUrl,
        width: sizeRef.current.width,
        height: sizeRef.current.height,
      },
      {
        onPhase: (value) => latest.current.onPhase(value),
        onWinner: (winner) => latest.current.onWinner(winner),
        onRecording: (state) => setRecording(state),
        onVideo: (video) => latest.current.onVideo(video),
      },
    )
      .then((stage) => {
        if (cancelled) {
          stage.destroy();
          return;
        }
        created = stage;
        stageRef.current = stage;
        stage.setSpeed(latest.current.speed);
        stage.setMode(latest.current.mode);
        stage.setLocale(latest.current.locale);
        stage.setRecording(latest.current.record);
        stage.setSound(latest.current.sound);
        stage.setView(latest.current.view, latest.current.follow);
        stage.setSkins(latest.current.skins);
        stage.setRun(latest.current.names, latest.current.seed, latest.current.track);
        // A custom map rebuilds the course, so it lands before the editor takes over.
        if (latest.current.customMap) stage.setCustomMap(latest.current.customMap);
        stage.setEditor(latest.current.editor);
        setReady(true);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      created?.destroy();
      if (stageRef.current === created) stageRef.current = null;
      setReady(false);
    };
  }, [measured, hydrated, renderer]);

  useEffect(() => {
    stageRef.current?.setRun(names, seed, track);
  }, [names, seed, track, ready]);

  useEffect(() => {
    stageRef.current?.setSpeed(speed);
  }, [speed, ready]);

  useEffect(() => {
    stageRef.current?.setMode(mode);
  }, [mode, ready]);

  useEffect(() => {
    stageRef.current?.setLocale(locale);
  }, [locale, ready]);

  useEffect(() => {
    stageRef.current?.setRecording(record);
  }, [record, ready]);

  useEffect(() => {
    stageRef.current?.setSound(sound);
  }, [sound, ready]);

  useEffect(() => {
    stageRef.current?.setView(view, follow);
  }, [view, follow, ready]);

  useEffect(() => {
    stageRef.current?.setSkins(skins);
  }, [skins, ready]);

  useEffect(() => {
    stageRef.current?.setCustomMap(customMap);
  }, [customMap, ready]);

  useEffect(() => {
    stageRef.current?.setEditor(editor);
  }, [editor, ready]);

  // Fullscreen applies to the board only - the canvas follows through the observer.
  useEffect(() => {
    setCanFullscreen(document.fullscreenEnabled && typeof boxRef.current?.requestFullscreen === 'function');
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Space starts or resets the race, so the board stays usable in fullscreen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      // Space pans the board while the editor is open, so it must not drop marbles.
      if (latest.current.editor) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      if (latest.current.phase === 'idle') latest.current.onStart();
      else if (latest.current.phase === 'reveal') latest.current.onReset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;

    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void box.requestFullscreen?.({ navigationUI: 'hide' }).catch((err: unknown) => {
        console.warn('[thorvg-pinrace] fullscreen was rejected:', err);
      });
    }
  }, []);

  const retry = useCallback(() => {
    setError(null);
    setMeasured(false);
    requestAnimationFrame(() => setMeasured(true));
  }, []);

  return (
    <div className="flex w-full justify-center">
      <div ref={boxRef} className="stage-frame" data-pinned={pinned} data-editing={editor !== null}>
        <canvas id={CANVAS_ID} className="block h-full w-full" />

        {canFullscreen && (
          <button
            type="button"
            onClick={toggleFullscreen}
            title={fullscreen ? t.exitFullscreen : t.enterFullscreen}
            aria-label={fullscreen ? t.exitFullscreen : t.enterFullscreen}
            className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-[9px] border text-[color:var(--ink-dim)] transition hover:text-white sm:h-8 sm:w-8"
            style={{ borderColor: 'var(--line)', background: 'rgba(16, 16, 19, 0.72)' }}
          >
            {fullscreen ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
              </svg>
            )}
          </button>
        )}

        {recording !== 'idle' && (
          <div
            className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px] font-semibold"
            style={{ borderColor: 'rgba(255,90,60,0.5)', background: 'rgba(16, 8, 8, 0.72)', color: '#ff8f6a' }}
          >
            <span
              className={`h-2 w-2 rounded-full ${recording === 'recording' ? 'animate-pulse' : ''}`}
              style={{ background: '#ff4a2b' }}
            />
            {recording === 'recording' ? t.rec : t.saving}
          </div>
        )}

        {fullscreen && !editor && (
          <div className="pointer-events-none absolute bottom-5 right-14 flex justify-end">
            <div
              className="pointer-events-auto flex items-center gap-2 rounded-xl border px-3 py-2"
              style={{ borderColor: 'var(--line)', background: 'rgba(16, 16, 19, 0.82)' }}
            >
              <button
                type="button"
                className="btn-primary px-5 py-2"
                onClick={onStart}
                disabled={!canStart || phase === 'preview' || phase === 'countdown' || phase === 'racing'}
              >
                {phase === 'reveal' ? messages.run.again : messages.run.drop}
              </button>
              <button type="button" className="btn-ghost" onClick={onReset} disabled={phase === 'idle'}>
                {messages.run.reset}
              </button>
            </div>
          </div>
        )}

        {!ready && !error && (
          <div className="absolute inset-0 grid place-items-center text-sm text-[color:var(--ink-dim)]">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 animate-ping rounded-full" style={{ background: 'var(--accent)' }} />
              {t.starting}
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm">
            <div>
              <p className="mb-3 font-semibold" style={{ color: '#ff8f6a' }}>{t.failed}</p>
              <p className="mb-4 text-[color:var(--ink-dim)]">{error}</p>
              <button className="btn-ghost" onClick={retry}>
                {t.retry}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default RaceStage;
