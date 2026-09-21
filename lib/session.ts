/**
 * Settings that survive a reload: everything the address bar does not already
 * carry is stashed here and read back on the way in.
 */

import { blueprintToJson, parseBlueprint, type Blueprint } from './blueprint';
import { readSkin, type Skin } from './skins';

const KEY = 'thor-pinball:session';

export interface SessionState {
  /** Marble artwork, keyed by runner name. */
  skins: Record<string, Skin>;
  speed: number;
  mode: string;
  view: string;
  follow: number | 'leader';
  record: boolean;
  sound: boolean;
  /** A hand drawn map, or null while the seeded generator is in charge. */
  map: Blueprint | null;
  /** Set when the marble artwork was too large to store. */
  skinsDropped?: boolean;
}

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Blocked by the browser; the session simply does not persist.
    return null;
  }
}

/** The same map with its artwork stripped, which is most of the weight. */
function withoutArtwork(map: Blueprint | null): Blueprint | null {
  if (!map) return null;
  return { ...map, items: map.items.filter((item) => item.kind !== 'decal') };
}

/**
 * Writes the session.
 *
 * Marble skins and map artwork both run to megabytes, and storage quotas are
 * small, so a session that will not fit sheds its heaviest parts in turn
 * rather than being dropped whole: first the marble skins, then the map
 * artwork, then the map. Everything else survives a reload either way.
 */
export function saveSession(state: SessionState): void {
  const target = store();
  if (!target) return;

  const write = (value: SessionState) =>
    target.setItem(
      KEY,
      JSON.stringify({
        ...value,
        map: value.map ? JSON.parse(blueprintToJson(value.map)) : null,
      }),
    );

  const attempts: SessionState[] = [
    { ...state, skinsDropped: false },
    { ...state, skins: {}, skinsDropped: true },
    { ...state, skins: {}, map: withoutArtwork(state.map), skinsDropped: true },
    { ...state, skins: {}, map: null, skinsDropped: true },
  ];

  for (const attempt of attempts) {
    try {
      write(attempt);
      return;
    } catch {
      // Too big for the quota; fall through to a lighter one.
    }
  }
}

export function loadSession(): Partial<SessionState> | null {
  const target = store();
  if (!target) return null;

  const raw = target.getItem(KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const skins: Record<string, Skin> = {};
    if (parsed.skins && typeof parsed.skins === 'object') {
      for (const [name, value] of Object.entries(parsed.skins as Record<string, unknown>)) {
        const skin = readSkin(value);
        if (skin) skins[name] = skin;
      }
    }

    return {
      skins,
      speed: typeof parsed.speed === 'number' ? parsed.speed : undefined,
      mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
      view: typeof parsed.view === 'string' ? parsed.view : undefined,
      follow:
        parsed.follow === 'leader' || typeof parsed.follow === 'number'
          ? (parsed.follow as number | 'leader')
          : undefined,
      record: typeof parsed.record === 'boolean' ? parsed.record : undefined,
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : undefined,
      map: parsed.map ? parseBlueprint(JSON.stringify(parsed.map)) : null,
      skinsDropped: parsed.skinsDropped === true,
    };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
