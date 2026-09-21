'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RendererType } from '@thorvg/webcanvas';
import BrandMark from '../components/BrandMark';
import NamePanel from '../components/NamePanel';
import Comments from '../components/Comments';
import MapEditorPanel from '../components/MapEditorPanel';
import Toggle from '../components/Toggle';
import RaceStage, { type StageHandle } from '../components/RaceStage';
import type { Blueprint } from '../lib/blueprint';
import { submitUrl } from '../lib/gallery';
import { decodeMap, encodeMap, hasArtwork, mapHash, readMapCode } from '../lib/mapLink';
import { compile } from '../lib/blueprint';
import { MAX_NAMES, TRACK_LENGTHS, createCourse, generateBlueprint, type TrackLength } from '../lib/course';
import { MapEditor } from '../lib/mapEditor';
import { DEFAULT_LOCALE, detectLocale, getMessages, type Locale } from '../lib/i18n';
import { css } from '../lib/palette';
import { exportRace } from '../lib/lottie/export';
import { isRecordingSupported, saveVideo, type RecordedVideo } from '../lib/recorder';
import { hashSeed, randomSeed } from '../lib/rng';
import type { Skin } from '../lib/skins';
import { loadSession, saveSession } from '../lib/session';
import { splitNames } from '../lib/share';
import type { FollowTarget, ViewMode, WinnerInfo } from '../lib/stage';
import type { Phase, RaceMode } from '../lib/types';

const DEMO_ROSTER = ['Thor', 'Odin', 'Freya', 'Loki', 'Sif', 'Baldr', 'Heimdall', 'Njord', 'Idun', 'Vidar'];

const RENDERERS: RendererType[] = ['sw', 'gl', 'wg'];

const SPEEDS = [
  { value: 0.75, key: 'slow' },
  { value: 1, key: 'normal' },
  { value: 1.5, key: 'fast' },
] as const;

const TRACKS: TrackLength[] = ['short', 'standard', 'epic'];

export default function Pinball() {
  const stageRef = useRef<StageHandle>(null);

  const [names, setNames] = useState<string[]>([]);
  const [seed, setSeed] = useState('THORVG');
  const [speed, setSpeed] = useState(1);
  const [mode, setMode] = useState<RaceMode>('winner');
  const [track, setTrack] = useState<TrackLength>('standard');
  const [renderer, setRenderer] = useState<RendererType>('gl');
  const [phase, setPhase] = useState<Phase>('idle');
  const [winner, setWinner] = useState<WinnerInfo | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [record, setRecord] = useState(false);
  const [sound, setSound] = useState(true);
  const [view, setView] = useState<ViewMode>('board');
  /** Marble artwork, keyed by runner name. */
  const [skins, setSkins] = useState<Record<string, Skin>>({});
  const [skinNote, setSkinNote] = useState<string | null>(null);
  const [follow, setFollow] = useState<FollowTarget>('leader');
  const [canRecord, setCanRecord] = useState(true);

  // The map editor lives outside React: it owns the blueprint and every
  // gesture on it, and the panel subscribes to its version counter.
  const [editor] = useState(() => new MapEditor());
  const [editing, setEditing] = useState(false);
  const [customMap, setCustomMap] = useState<Blueprint | null>(null);
  /** The map packed for the address bar, and why it could not be. */
  const [mapCode, setMapCode] = useState<string | null>(null);
  const [mapLinkNote, setMapLinkNote] = useState<'too-large' | 'unsupported' | null>(null);
  const [baking, setBaking] = useState(false);
  const [bakeTrails, setBakeTrails] = useState(false);

  const t = getMessages(locale);

  // Null when the map is too long for GitHub to open an issue with.
  const submitLink = mapCode ? submitUrl(mapCode) : null;

  const running = phase === 'preview' || phase === 'countdown' || phase === 'racing';
  const locked = running || editing;
  // A runner can be removed while selected, so fall back to the leader.
  const safeFollow: FollowTarget = typeof follow === 'number' && follow < names.length ? follow : 'leader';

  // Client only checks, kept out of the server render so hydration matches.
  useEffect(() => {
    setLocale(detectLocale());
    setCanRecord(isRecordingSupported());
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Restore a shared run from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get('names');
    const sharedSeed = params.get('seed');
    const sharedRenderer = params.get('renderer') as RendererType | null;
    const sharedTrack = params.get('track') as TrackLength | null;
    const sharedMode = params.get('mode');

    if (shared) setNames(splitNames(shared).slice(0, MAX_NAMES));
    if (sharedSeed) setSeed(sharedSeed.toUpperCase().slice(0, 10));
    if (sharedRenderer && RENDERERS.includes(sharedRenderer) && (sharedRenderer !== 'wg' || 'gpu' in navigator)) {
      setRenderer(sharedRenderer);
    }
    if (sharedTrack && TRACKS.includes(sharedTrack)) setTrack(sharedTrack);
    if (sharedMode === 'ranking' || sharedMode === 'winner') setMode(sharedMode);

    // Everything the address bar does not carry, stashed before the reload.
    const session = loadSession();
    if (session) {
      if (session.skins) setSkins(session.skins);
      if (session.speed !== undefined) setSpeed(session.speed);
      if (session.mode === 'winner' || session.mode === 'ranking') setMode(session.mode);
      if (session.view === 'board' || session.view === 'ride') setView(session.view);
      if (session.follow !== undefined) setFollow(session.follow);
      if (session.record !== undefined) setRecord(session.record);
      if (session.sound !== undefined) setSound(session.sound);
      if (session.map) setCustomMap(session.map);
      if (session.skinsDropped) setSkinNote(getMessages(detectLocale()).skin.dropped);
    }

    // A map in the link is an explicit choice, so it wins over the stash. The
    // decode is async, and hydration waits for it: the address bar is rewritten
    // the moment hydration finishes, and doing that before the map lands would
    // drop the very link the visitor arrived on.
    const code = readMapCode(window.location.hash);
    if (!code) {
      setHydrated(true);
      return;
    }
    void decodeMap(code).then((map) => {
      if (map) setCustomMap(map);
      setHydrated(true);
    });
  }, []);

  // Pack the map for the address bar whenever it changes.
  useEffect(() => {
    if (!hydrated) return;
    if (!customMap) {
      setMapCode(null);
      setMapLinkNote(null);
      return;
    }

    let live = true;
    void encodeMap(customMap).then((result) => {
      if (!live) return;
      if ('code' in result) {
        setMapCode(result.code);
        setMapLinkNote(null);
      } else {
        setMapCode(null);
        setMapLinkNote(result.error);
      }
    });
    return () => {
      live = false;
    };
  }, [customMap, hydrated]);

  // Keep the stash current so a reload never loses the setup.
  useEffect(() => {
    if (!hydrated) return;
    saveSession({ skins, speed, mode, view, follow, record, sound, map: customMap });
  }, [skins, speed, mode, view, follow, record, sound, customMap, hydrated]);

  // Keep the address bar shareable.
  useEffect(() => {
    if (!hydrated) return;
    // Started from what is already there, not from nothing: the address bar can
    // be carrying somebody else's parameter, and rebuilding the query from our
    // own state alone would throw it away. giscus hands its sign-in token back
    // exactly that way, so wiping the query silently undid every login.
    const params = new URLSearchParams(window.location.search);
    const own = (key: string, value: string | null) => (value === null ? params.delete(key) : params.set(key, value));

    own('names', names.length ? names.join(',') : null);
    own('seed', seed);
    own('renderer', renderer !== 'gl' ? renderer : null);
    own('track', track !== 'standard' ? track : null);
    own('mode', mode !== 'winner' ? mode : null);
    own('lang', locale !== DEFAULT_LOCALE ? locale : null);
    // The map rides in the hash: the server has no use for it, and keeping it
    // out of the query keeps every request small.
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params.toString()}${mapHash(mapCode)}`,
    );
    setCopied(false);
  }, [names, seed, renderer, track, mode, locale, mapCode, hydrated]);

  // Runs after RaceStage has pushed the new roster into the stage.
  useEffect(() => {
    if (!autoStart) return;
    setAutoStart(false);
    if (names.length >= 2) stageRef.current?.start();
  }, [names, autoStart]);

  const addNames = useCallback((raw: string) => {
    setNames((current) => {
      const taken = new Set(current.map((name) => name.toLowerCase()));
      const next = [...current];
      for (const name of splitNames(raw)) {
        if (next.length >= MAX_NAMES) break;
        if (taken.has(name.toLowerCase())) continue;
        taken.add(name.toLowerCase());
        next.push(name);
      }
      return next;
    });
    setWinner(null);
  }, []);

  const removeName = useCallback((index: number) => {
    setNames((current) => current.filter((_, i) => i !== index));
    setWinner(null);
  }, []);

  const clearNames = useCallback(() => {
    setNames([]);
    setWinner(null);
    stageRef.current?.reset();
  }, []);

  const loadDemo = useCallback(() => {
    setNames(DEMO_ROSTER.slice(0, MAX_NAMES));
    setWinner(null);
    stageRef.current?.reset();
  }, []);

  const start = useCallback(() => {
    setWinner(null);
    stageRef.current?.start();
  }, []);

  const stop = useCallback(() => {
    setWinner(null);
    stageRef.current?.reset();
  }, []);

  const rerollSeed = useCallback(() => {
    setSeed(randomSeed());
    setWinner(null);
  }, []);

  const dropWinner = useCallback(() => {
    if (!winner) return;
    setNames((current) => current.filter((name) => name !== winner.name));
    setWinner(null);
    setSeed(randomSeed());
    setAutoStart(true);
  }, [winner]);

  const onVideo = useCallback(
    (video: RecordedVideo) => {
      const winnerName = winner?.name.replace(/[^\p{L}\p{N}_-]+/gu, '') || 'race';
      saveVideo(video, `thorvg-pinrace-${seed}-${winnerName}`);
    },
    [seed, winner],
  );

  const setSkin = useCallback((name: string, skin: Skin | null) => {
    setSkinNote(null);
    // A Lottie chip shows a still of its first frame, drawn by the engine.
    const withThumb =
      skin && skin.kind === 'lottie' && !skin.thumb
        ? { ...skin, thumb: stageRef.current?.thumbnail(skin) ?? undefined }
        : skin;

    setSkins((current) => {
      const next = { ...current };
      if (withThumb) next[name] = withThumb;
      else delete next[name];
      return next;
    });
  }, []);

  /** The track the editor should open on: the custom map, or this seed's. */
  const seededBlueprint = useCallback(
    () => generateBlueprint(hashSeed(seed), TRACK_LENGTHS[track], seed),
    [seed, track],
  );

  const openEditor = useCallback(() => {
    stageRef.current?.reset();
    setWinner(null);
    editor.load(customMap ?? seededBlueprint());
    setEditing(true);
  }, [customMap, editor, seededBlueprint]);

  const applyMap = useCallback(() => {
    setCustomMap(editor.snapshotBlueprint());
    setWinner(null);
    setEditing(false);
  }, [editor]);

  const closeEditor = useCallback(() => {
    setEditing(false);
  }, []);

  const regenerateMap = useCallback(() => {
    editor.replace(seededBlueprint(), true);
  }, [editor, seededBlueprint]);

  /** A whole new track: fresh seed, fresh length, artwork left where it is. */
  const randomMap = useCallback(() => {
    const sections = 8 + Math.floor(Math.random() * 17);
    editor.replace(generateBlueprint(hashSeed(randomSeed()), sections), true);
  }, [editor]);

  const dropCustomMap = useCallback(() => {
    setCustomMap(null);
    setWinner(null);
  }, []);

  /**
   * Bakes the run into a Lottie: the same physics, written down as vector
   * keyframes rather than drawn. Everything it needs is pure data, so it runs
   * here with no engine and no recording pass.
   */
  const bakeLottie = useCallback(() => {
    if (names.length < 2) return;
    setBaking(true);

    // Yielded to the browser first, so the button can show it is working.
    setTimeout(() => {
      try {
        const course = customMap ? compile(customMap) : createCourse(hashSeed(seed), TRACK_LENGTHS[track]);
        const result = exportRace({
          course,
          names,
          seed,
          mode,
          fps: 30,
          maxSeconds: 120,
          trails: bakeTrails,
          skinFor: (name) => skins[name],
        });

        const blob = new Blob([JSON.stringify(result.document)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `thorvg-pinrace-${seed}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } finally {
        setBaking(false);
      }
    }, 30);
  }, [names, seed, track, mode, customMap, skins, bakeTrails]);

  const copyLink = useCallback(() => {
    void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
  }, []);

  const status = useMemo(() => {
    switch (phase) {
      case 'countdown':
        return t.status.countdown;
      case 'preview':
        return t.status.preview;
      case 'racing':
        return t.status.racing;
      case 'reveal':
        return t.status.reveal;
      default:
        return names.length ? t.status.ready : t.status.empty;
    }
  }, [phase, names.length, t]);

  return (
    <main className="app-shell mx-auto flex min-h-screen w-full max-w-[1180px] flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <BrandMark />
          <h1 className="text-[22px] font-semibold tracking-tight sm:text-[25px]">ThorVG Pinrace</h1>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <button
            type="button"
            className="btn-ghost px-3 py-[7px] text-xs"
            data-active={editing}
            style={editing ? { borderColor: 'rgba(0, 224, 160, 0.4)', color: '#5ff0c4' } : undefined}
            disabled={running}
            onClick={() => (editing ? applyMap() : openEditor())}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <path d="M2.6 10.9l7.5-7.5 2.5 2.5-7.5 7.5-3 .5z" strokeLinejoin="round" />
              <path d="M9.4 4.1l2.5 2.5" />
            </svg>
            {editing ? t.editor.save : t.editor.open}
          </button>

          <a className="btn-ghost px-3 py-[7px] text-xs" href="/gallery">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="2.2" y="2.6" width="4.6" height="10.8" rx="1.2" />
              <rect x="9.2" y="2.6" width="4.6" height="6.4" rx="1.2" />
            </svg>
            {t.editor.gallery}
          </a>

        </div>
      </header>

      <div className="bolt-rule -mt-2" aria-hidden="true" />

      <div className="app-grid grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[352px_minmax(0,1fr)]">
        <aside className="app-aside order-2 flex flex-col gap-4 lg:order-1">
          {editing ? (
            <MapEditorPanel
              editor={editor}
              messages={t}
              onExit={closeEditor}
              onRegenerate={regenerateMap}
              onRandom={randomMap}
              onZoom={(factor) => stageRef.current?.zoomBy(factor)}
              onLookAt={(y) => stageRef.current?.lookAt(y)}
            />
          ) : (
          <>
          <div className="panel p-4">
            <div className="mb-3 flex items-center justify-between text-[13px]">
              <span className="font-semibold">{status}</span>
              <span className="text-[color:var(--ink-dim)]">{t.run.runners(names.length)}</span>
            </div>

            <button
              type="button"
              className="btn-primary w-full py-2.5 text-sm"
              onClick={start}
              disabled={names.length < 2 || running}
            >
              {running ? t.run.running : phase === 'reveal' ? t.run.again : t.run.drop}
            </button>

            {names.length < 2 && (
              <p className="mt-2 text-center text-[11px] text-[color:var(--ink-dim)]">{t.run.needTwo}</p>
            )}

            {customMap && (
              <div className="mt-2.5 flex items-center justify-between gap-2 rounded-[9px] border px-2.5 py-1.5 text-[11px]"
                   style={{ borderColor: 'rgba(0, 224, 160, 0.32)', background: 'var(--cool-soft)' }}>
                <span style={{ color: '#5ff0c4' }}>{t.editor.custom}</span>
                <button
                  type="button"
                  className="underline underline-offset-2 text-[color:var(--ink-dim)] transition hover:text-white"
                  disabled={running}
                  onClick={dropCustomMap}
                >
                  {t.editor.useGenerated}
                </button>
              </div>
            )}

            {customMap && submitLink && (
              <a
                className="btn-ghost mt-2 w-full py-1.5 text-[11px]"
                href={submitLink}
                target="_blank"
                rel="noreferrer"
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                  <path d="M8 .5a7.5 7.5 0 00-2.37 14.62c.37.07.51-.16.51-.36l-.01-1.26c-2.09.45-2.53-1-2.53-1-.34-.87-.83-1.1-.83-1.1-.68-.47.05-.46.05-.46.75.05 1.15.78 1.15.78.67 1.15 1.76.82 2.19.63.07-.49.26-.82.48-1.01-1.67-.19-3.43-.84-3.43-3.73 0-.82.3-1.5.78-2.03-.08-.19-.34-.96.07-2.01 0 0 .63-.2 2.07.78a7.2 7.2 0 013.77 0c1.44-.98 2.07-.78 2.07-.78.41 1.05.15 1.82.08 2.01.49.53.78 1.21.78 2.03 0 2.9-1.77 3.54-3.45 3.72.27.24.51.69.51 1.4l-.01 2.08c0 .2.14.44.52.36A7.5 7.5 0 008 .5z" />
                </svg>
                {t.editor.shareGallery}
              </a>
            )}

            {customMap && (mapLinkNote !== null || hasArtwork(customMap)) && (
              <p className="mt-1.5 px-0.5 text-[10px] leading-relaxed text-[color:var(--ink-dim)]">
                {mapLinkNote === 'too-large'
                  ? t.editor.linkTooLarge
                  : mapLinkNote === 'unsupported'
                    ? t.editor.linkUnsupported
                    : t.editor.linkNoArtwork}
              </p>
            )}

            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <button type="button" className="btn-ghost" onClick={stop} disabled={phase === 'idle'}>
                {t.run.reset}
              </button>
              <button type="button" className="btn-ghost" onClick={rerollSeed} disabled={running}>
                {t.run.newSeed}
              </button>
            </div>
          </div>

          {winner && (
            <div className="panel rise p-4" style={{ borderColor: css(winner.color, 0.42) }}>
              <p className="text-[11px] font-medium tracking-wide text-[color:var(--ink-dim)]">{t.winner.label}</p>
              <div className="mt-1.5 flex items-center gap-2.5">
                <span
                  className="h-7 w-7 shrink-0 rounded-full"
                  style={{ background: css(winner.color) }}
                />
                <p className="truncate text-lg font-semibold">{winner.name}</p>
              </div>
              <p className="mt-2 text-[12px] text-[color:var(--ink-dim)]">
                {winner.photoFinish ? t.winner.photoPrefix : ''}
                {t.winner.result(winner.elapsed.toFixed(2), seed)}
              </p>
              {winner.ranking.length > 1 && (
                <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
                  <p className="label">{t.winner.ranking}</p>
                  <ol className="scroll-thin max-h-60 overflow-y-auto pr-1">
                    {winner.ranking.map((entry) => (
                      <li
                        key={entry.index}
                        className="flex items-center gap-2 py-[3px] text-[12px]"
                      >
                        <span className="w-5 shrink-0 text-right text-[color:var(--ink-dim)]">
                          {entry.place}
                        </span>
                        <span
                          className="h-3 w-3 shrink-0 rounded-full"
                          style={{ background: css(entry.color) }}
                        />
                        <span className="truncate">{entry.name}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-[color:var(--ink-dim)]">
                          {entry.elapsed === null ? t.winner.dnf : `${entry.elapsed.toFixed(2)}s`}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" className="btn-ghost" onClick={start}>
                  {t.winner.again}
                </button>
                <button type="button" className="btn-ghost" onClick={dropWinner} disabled={names.length < 3}>
                  {t.winner.drop}
                </button>
              </div>
            </div>
          )}

          <NamePanel
            names={names}
            messages={t}
            disabled={running}
            skins={skins}
            onAdd={addNames}
            onRemove={removeName}
            onClear={clearNames}
            onDemo={loadDemo}
            onSkin={setSkin}
            onSkinError={setSkinNote}
          />

          {skinNote && (
            <p className="px-1 text-[11px] leading-relaxed" style={{ color: '#ff8f6a' }}>
              {skinNote}
            </p>
          )}

          <div className="panel p-4">
            <h2 className="mb-3 text-[13px] font-semibold">{t.settings.title}</h2>

            <label className="label" htmlFor="seed">
              {t.settings.seed}
            </label>
            <div className="flex gap-2">
              <input
                id="seed"
                className="field font-mono uppercase tracking-widest"
                value={seed}
                maxLength={10}
                disabled={running}
                onChange={(event) => {
                  setSeed(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'X');
                  setWinner(null);
                }}
              />
              <button type="button" className="btn-ghost shrink-0" onClick={copyLink}>
                {copied ? t.settings.copied : t.settings.copy}
              </button>
            </div>

            <label className="label mt-4">{t.settings.mode}</label>
            <div className="segment">
              {(['winner', 'ranking'] as RaceMode[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  data-active={mode === value}
                  disabled={running}
                  onClick={() => setMode(value)}
                >
                  {value === 'winner' ? t.settings.modeWinner : t.settings.modeRanking}
                </button>
              ))}
            </div>

            <label className="label mt-4">{t.settings.view}</label>
            <div className="segment">
              {(['board', 'ride'] as ViewMode[]).map((mode) => (
                <button key={mode} type="button" data-active={view === mode} onClick={() => setView(mode)}>
                  {mode === 'board' ? t.settings.viewBoard : t.settings.viewRide}
                </button>
              ))}
            </div>

            {view === 'ride' && (
              <>
                <label className="label mt-3" htmlFor="follow">
                  {t.settings.follow}
                </label>
                <select
                  id="follow"
                  className="field"
                  value={typeof safeFollow === 'number' ? String(safeFollow) : 'leader'}
                  onChange={(event) =>
                    setFollow(event.target.value === 'leader' ? 'leader' : Number(event.target.value))
                  }
                >
                  <option value="leader">{t.settings.followLeader}</option>
                  {names.map((name, index) => (
                    <option key={`${name}-${index}`} value={index}>
                      {name}
                    </option>
                  ))}
                </select>
              </>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium text-[color:var(--ink-dim)]">{t.settings.sound}</p>
              <Toggle checked={sound} label={t.settings.sound} onChange={setSound} />
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium text-[color:var(--ink-dim)]">{t.settings.record}</p>
              <Toggle
                checked={record && canRecord}
                disabled={!canRecord || running}
                label={t.settings.record}
                onChange={setRecord}
              />
            </div>
            {!canRecord && (
              <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--ink-dim)]">
                {t.settings.recordUnsupported}
              </p>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium text-[color:var(--ink-dim)]">{t.settings.lottieTrails}</p>
              <Toggle
                checked={bakeTrails}
                disabled={running}
                label={t.settings.lottieTrails}
                onChange={setBakeTrails}
              />
            </div>

            <button
              type="button"
              className="btn-ghost mt-2 w-full py-2 text-[12px]"
              disabled={names.length < 2 || running || baking}
              onClick={bakeLottie}
            >
              {baking ? t.settings.lottieBaking : t.settings.lottie}
            </button>
            <p className="mt-1 text-[10px] leading-relaxed text-[color:var(--ink-dim)]">
              {t.settings.lottieHint}
            </p>

            <label className="label mt-4">{t.settings.track}</label>
            <div className="segment">
              {TRACKS.map((id) => (
                <button
                  key={id}
                  type="button"
                  data-active={track === id}
                  disabled={running || customMap !== null}
                  title={t.settings.tracks[id].hint}
                  onClick={() => {
                    setTrack(id);
                    setWinner(null);
                  }}
                >
                  {t.settings.tracks[id].label}
                </button>
              ))}
            </div>

            <label className="label mt-4">{t.settings.speed}</label>
            <div className="segment">
              {SPEEDS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  data-active={speed === item.value}
                  onClick={() => setSpeed(item.value)}
                >
                  {t.settings.speeds[item.key]}
                </button>
              ))}
            </div>
          </div>
          </>
          )}
        </aside>

        <section className="app-stage order-1 lg:order-2">
          <RaceStage
            ref={stageRef}
            names={names}
            seed={seed}
            speed={speed}
            mode={mode}
            track={track}
            renderer={renderer}
            locale={locale}
            messages={t}
            phase={phase}
            canStart={names.length >= 2}
            hydrated={hydrated}
            view={view}
            follow={safeFollow}
            skins={skins}
            record={record && canRecord}
            sound={sound}
            editor={editing ? editor : null}
            customMap={customMap}
            onStart={start}
            onReset={stop}
            onPhase={setPhase}
            onWinner={setWinner}
            onVideo={onVideo}
          />
        </section>
      </div>

      <section className="mt-6 border-t pt-6" style={{ borderColor: 'var(--line)' }}>
        <Comments lang={locale} />
      </section>

      <footer className="pb-3 text-center text-[11px] leading-relaxed text-[color:var(--ink-dim)]">
        Copyright (c) 2026 ThorVG Project
        <br />
        MIT License
      </footer>
    </main>
  );
}
