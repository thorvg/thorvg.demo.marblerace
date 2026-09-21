/**
 * The map gallery, kept in GitHub issues.
 *
 * A submission is an issue carrying a map code. The gallery reads those issues
 * straight from the browser when someone opens the page: GitHub serves a public
 * repository's issues unauthenticated and with an open CORS policy, so there is
 * no key to hold, no database, no build step and nothing of ours running. What
 * GitHub already provides — accounts, moderation, and a discussion under every
 * submission — is the whole backend.
 */

import { decodeMap } from './mapLink';
import type { Blueprint } from './blueprint';

/** Where submissions go. A fork points this at its own issues. */
export const GITHUB_REPO = 'OSSCA-thorvg/thor-pinball';

/** Enough to be a map code and not a word someone typed. */
const CODE_PATTERN = /[A-Za-z0-9_-]{200,}/;

/** The label a submission carries, when whoever opened it was able to set one. */
const LABEL = 'map';

/** Title the share button fills in, for submissions that could not be labelled. */
const TITLE_PREFIX = /^\s*\[map\]/i;

/** Keeps one busy week from turning the page into a thousand decodes. */
const MAX_ENTRIES = 60;

/** How long a tab reuses what it already fetched, on top of GitHub's own minute. */
const CACHE_MS = 5 * 60 * 1000;

const CACHE_KEY = 'thor-pinball:gallery';

export interface GalleryMap {
  /** Issue number, which is also the entry's identity. */
  number: number;
  title: string;
  /** GitHub handle of whoever opened the issue. */
  author: string;
  /** Packed map, the same code the address bar carries. */
  code: string;
  /** Issue URL, which doubles as the discussion for this map. */
  url: string;
  pieces: number;
  /** Track length in world units, for the card and the mini map. */
  height: number;
  blueprint: Blueprint;
}

export type GalleryResult =
  | { ok: true; maps: GalleryMap[] }
  /** GitHub's hourly allowance for this address is spent. */
  | { ok: false; reason: 'rate-limited'; resetAt: number }
  | { ok: false; reason: 'failed' };

interface Issue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  labels?: Array<{ name?: string } | string>;
  pull_request?: unknown;
}

/**
 * Whether an issue is offering a map.
 *
 * The label is the reliable signal, but only a collaborator can apply one:
 * GitHub drops the `labels` parameter for anyone without write access. So the
 * title the share button fills in counts too, and an outside contributor's
 * submission is listed either way. Closing an issue still removes it, which is
 * what keeps moderation working.
 */
function isSubmission(issue: Issue): boolean {
  if (issue.pull_request) return false;
  const labelled = (issue.labels ?? []).some(
    (label) => (typeof label === 'string' ? label : label?.name) === LABEL,
  );
  return labelled || TITLE_PREFIX.test(issue.title);
}

function cleanTitle(title: string): string {
  return title.replace(/^\s*\[map\]\s*/i, '').trim() || 'Untitled map';
}

function readCache(): GalleryMap[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; maps: GalleryMap[] };
    return Date.now() - parsed.at < CACHE_MS ? parsed.maps : null;
  } catch {
    // Blocked or corrupt; the gallery just fetches again.
    return null;
  }
}

function writeCache(maps: GalleryMap[]): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), maps }));
  } catch {
    // Over quota, or storage is off. Nothing here is worth failing over.
  }
}

/** Turns issues into gallery entries, dropping any whose code will not decode. */
async function toMaps(issues: Issue[]): Promise<GalleryMap[]> {
  const entries = await Promise.all(
    issues.filter(isSubmission).map(async (issue): Promise<GalleryMap | null> => {
      const code = issue.body?.match(CODE_PATTERN)?.[0];
      if (!code) return null;

      const blueprint = await decodeMap(code);
      if (!blueprint || !blueprint.items.length) return null;

      return {
        number: issue.number,
        title: cleanTitle(issue.title),
        author: issue.user?.login ?? 'unknown',
        code,
        url: issue.html_url,
        pieces: blueprint.items.length,
        height: blueprint.finishY + 260,
        blueprint,
      };
    }),
  );

  return entries
    .filter((entry): entry is GalleryMap => entry !== null)
    .sort((a, b) => b.number - a.number)
    .slice(0, MAX_ENTRIES);
}

export async function fetchGallery(): Promise<GalleryResult> {
  const cached = readCache();
  if (cached) {
    // Blueprints do not survive a round trip through storage, so they are
    // rebuilt from the codes that did.
    const maps = await Promise.all(
      cached.map(async (map) => ({ ...map, blueprint: await decodeMap(map.code) })),
    );
    return { ok: true, maps: maps.filter((m): m is GalleryMap => m.blueprint !== null) };
  }

  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/issues?state=open&per_page=100`,
      { headers: { accept: 'application/vnd.github+json' } },
    );
  } catch {
    return { ok: false, reason: 'failed' };
  }

  if (response.status === 403 || response.status === 429) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    return { ok: false, reason: 'rate-limited', resetAt: Number.isFinite(reset) ? reset * 1000 : 0 };
  }
  if (!response.ok) return { ok: false, reason: 'failed' };

  try {
    const maps = await toMaps((await response.json()) as Issue[]);
    writeCache(maps);
    return { ok: true, maps };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * GitHub refuses to open an issue past roughly this much URL, so a map that
 * would not fit is not offered for submission at all.
 */
const SUBMIT_URL_MAX = 7000;

/**
 * A prefilled issue, which is the whole submission flow: the visitor lands on
 * GitHub already holding the map and only has to name it.
 *
 * The body is filled directly rather than through an issue template. A
 * `template` parameter is resolved against the repository's default branch, so
 * it drops the prefill entirely wherever the template file has not landed — and
 * it fails by quietly opening a blank issue, which is the worst way for this to
 * break. Filling the body needs nothing to exist.
 */
export function submitUrl(code: string, title = ''): string | null {
  const body = [
    'Built in the map editor.',
    '',
    '### Map code',
    '',
    '```',
    code,
    '```',
    '',
    '_The gallery reads the code above, so editing it will break the map._',
  ].join('\n');

  const params = new URLSearchParams({ labels: LABEL, title: `[map] ${title}`.trim(), body });
  const url = `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
  return url.length > SUBMIT_URL_MAX ? null : url;
}

export function galleryIssuesUrl(): string {
  return `https://github.com/${GITHUB_REPO}/issues?q=is%3Aissue+is%3Aopen+label%3Amap`;
}
