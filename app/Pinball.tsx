'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RendererType } from '@thorvg/webcanvas';
import BrandMark from '../components/BrandMark';
import NamePanel from '../components/NamePanel';
import Comments from '../components/Comments';
import MapEditorPanel from '../components/MapEditorPanel';
import RaceStage, { type StageHandle } from '../components/RaceStage';
import type { Blueprint } from '../lib/blueprint';
import { submitUrl } from '../lib/gallery';
import { decodeMap, encodeMap, mapHash, readMapCode } from '../lib/mapLink';
import { MAX_NAMES, TRACK_LENGTHS, generateBlueprint, type TrackLength } from '../lib/course';
import { MapEditor } from '../lib/mapEditor';
import { DEFAULT_LOCALE, detectLocale, getMessages, type Locale } from '../lib/i18n';
import { hashSeed, randomSeed } from '../lib/rng';
import type { Skin } from '../lib/skins';
import { loadSession, saveSession } from '../lib/session';
import { splitNames } from '../lib/share';
import type { WinnerInfo } from '../lib/stage';
import type { Phase, RaceMode } from '../lib/types';

const RENDERERS: RendererType[] = ['sw', 'gl', 'wg'];

const TRACKS: TrackLength[] = ['short', 'standard', 'epic'];

export default function Pinball() {
  const stageRef = useRef<StageHandle>(null);

  const [names, setNames] = useState<string[]>([]);
  const [seed, setSeed] = useState('THORVG');
  const [mode, setMode] = useState<RaceMode>('winner');
  const [track, setTrack] = useState<TrackLength>('standard');
  const [renderer, setRenderer] = useState<RendererType>('gl');
  const [phase, setPhase] = useState<Phase>('idle');
  const [winner, setWinner] = useState<WinnerInfo | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  /** Marble artwork, keyed by runner name. */
  const [skins, setSkins] = useState<Record<string, Skin>>({});
  const [skinNote, setSkinNote] = useState<string | null>(null);

  // The map editor lives outside React: it owns the blueprint and every
  // gesture on it, and the panel subscribes to its version counter.
  const [editor] = useState(() => new MapEditor());
  const [editing, setEditing] = useState(false);
  const [customMap, setCustomMap] = useState<Blueprint | null>(null);
  const [mapCode, setMapCode] = useState<string | null>(null);

  const t = getMessages(locale);

  // Null when the map is too long for GitHub to open an issue with.
  const submitLink = mapCode ? submitUrl(mapCode) : null;

  const running = phase === 'preview' || phase === 'countdown' || phase === 'racing';

  // Client only, kept out of the server render so hydration matches.
  useEffect(() => {
    setLocale(detectLocale());
    setSeed(randomSeed());
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Restore a shared run from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get('names');
    const sharedRenderer = params.get('renderer') as RendererType | null;
    const sharedTrack = params.get('track') as TrackLength | null;
    const sharedMode = params.get('mode');

    if (shared) setNames(splitNames(shared).slice(0, MAX_NAMES));
    if (sharedRenderer && RENDERERS.includes(sharedRenderer) && (sharedRenderer !== 'wg' || 'gpu' in navigator)) {
      setRenderer(sharedRenderer);
    }
    if (sharedTrack && TRACKS.includes(sharedTrack)) setTrack(sharedTrack);
    if (sharedMode === 'ranking' || sharedMode === 'winner') setMode(sharedMode);

    // Everything the address bar does not carry, stashed before the reload.
    const session = loadSession();
    if (session) {
      if (session.skins) setSkins(session.skins);
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
      return;
    }

    let live = true;
    void encodeMap(customMap).then((result) => {
      if (live) setMapCode('code' in result ? result.code : null);
    });
    return () => {
      live = false;
    };
  }, [customMap, hydrated]);

  // Keep the stash current so a reload never loses the setup.
  useEffect(() => {
    if (!hydrated) return;
    saveSession({ skins, map: customMap });
  }, [skins, customMap, hydrated]);

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
    own('seed', null);
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
  }, [names, renderer, track, mode, locale, mapCode, hydrated]);

  // Runs after RaceStage has pushed the new roster and seed into the stage.
  useEffect(() => {
    if (!autoStart) return;
    setAutoStart(false);
    if (names.length >= 2) stageRef.current?.start();
  }, [names, seed, autoStart]);

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

  const start = useCallback(() => {
    setWinner(null);
    setSeed(randomSeed());
    setAutoStart(true);
  }, []);

  const stop = useCallback(() => {
    setWinner(null);
    stageRef.current?.reset();
  }, []);

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

  const status = useMemo(() => {
    switch (phase) {
      case 'countdown':
        return t.status.countdown;
      case 'preview':
        return t.status.preview;
      case 'racing':
        return t.status.racing;
      case 'reveal':
        return winner ? `${t.winner.label} · ${winner.name}` : t.status.reveal;
      default:
        return names.length ? t.status.ready : t.status.empty;
    }
  }, [phase, names.length, winner, t]);

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
          <NamePanel
            names={names}
            messages={t}
            disabled={running}
            skins={skins}
            title={status}
            onAdd={addNames}
            onRemove={removeName}
            onSkin={setSkin}
            onSkinError={setSkinNote}
          >
            <button
              type="button"
              className="btn-primary mt-4 w-full py-2.5 text-sm"
              onClick={start}
              disabled={names.length < 2 || running}
            >
              {running ? t.run.running : phase === 'reveal' ? t.run.again : t.run.drop}
            </button>


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

          </NamePanel>

          {skinNote && (
            <p className="px-1 text-[11px] leading-relaxed" style={{ color: '#ff8f6a' }}>
              {skinNote}
            </p>
          )}
          </>
          )}
        </aside>

        <section className="app-stage order-1 lg:order-2">
          <RaceStage
            ref={stageRef}
            names={names}
            seed={seed}
            speed={1}
            mode={mode}
            track={track}
            renderer={renderer}
            locale={locale}
            messages={t}
            phase={phase}
            canStart={names.length >= 2}
            hydrated={hydrated}
            view="board"
            follow="leader"
            skins={skins}
            record={false}
            sound
            editor={editing ? editor : null}
            customMap={customMap}
            onStart={start}
            onReset={stop}
            onPhase={setPhase}
            onWinner={setWinner}
            onVideo={() => {}}
          />
        </section>
      </div>

      <section className="mt-6 border-t pt-6" style={{ borderColor: 'var(--line)' }}>
        <Comments lang={locale} />
      </section>

      <footer className="pb-3 text-center text-[11px] leading-relaxed text-[color:var(--ink-dim)]">
        Thor Pinrace powered by ThorVG Engine
      </footer>
    </main>
  );
}
