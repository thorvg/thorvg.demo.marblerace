'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import MiniMap from './MiniMap';
import { fetchGallery, type GalleryMap, type GalleryResult } from '../lib/gallery';

/** Sections, counted back from the finish, which is what people compare. */
function sections(height: number): number {
  return Math.max(1, Math.round((height - 560) / 540));
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="panel grid place-items-center p-12 text-center text-[13px] leading-relaxed text-[color:var(--ink-dim)]">
      <div>{children}</div>
    </div>
  );
}

function Card({ map }: { map: GalleryMap }) {
  return (
    <li className="panel flex gap-3 p-3">
      <Link href={`/#map=${map.code}`} className="shrink-0" aria-label={`Race ${map.title}`}>
        <MiniMap blueprint={map.blueprint} className="block rounded-lg" />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-[14px] font-semibold" title={map.title}>
          {map.title}
        </h2>
        <p className="mt-0.5 truncate text-[11px] text-[color:var(--ink-dim)]">
          by{' '}
          <a
            className="underline underline-offset-2 hover:text-[color:var(--ink)]"
            href={`https://github.com/${map.author}`}
            target="_blank"
            rel="noreferrer"
          >
            {map.author}
          </a>
        </p>
        <p className="mt-2 text-[11px] text-[color:var(--ink-dim)]">
          {map.pieces} pieces · {sections(map.height)} sections
        </p>

        <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
          <Link className="btn-ghost px-2.5 py-1 text-[11px]" href={`/#map=${map.code}`}>
            Race it
          </Link>
          <a className="btn-ghost px-2.5 py-1 text-[11px]" href={map.url} target="_blank" rel="noreferrer">
            Discuss
          </a>
        </div>
      </div>
    </li>
  );
}

/**
 * The gallery, read from GitHub when the page opens.
 *
 * One request, unauthenticated, and GitHub's own `max-age=60` means a quick
 * revisit costs nothing at all. The hourly allowance is counted per address
 * rather than per site, so an ordinary visitor never comes close — but a shared
 * one can, and that says so plainly instead of showing an empty gallery.
 */
export default function GalleryList() {
  const [result, setResult] = useState<GalleryResult | null>(null);

  useEffect(() => {
    let live = true;
    void fetchGallery().then((value) => {
      if (live) setResult(value);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!result) {
    return (
      <Notice>
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 animate-ping rounded-full" style={{ background: 'var(--accent)' }} />
          Loading maps…
        </span>
      </Notice>
    );
  }

  if (!result.ok) {
    if (result.reason === 'rate-limited') {
      const at = result.resetAt
        ? new Date(result.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;
      return (
        <Notice>
          <p>GitHub is rate limiting this network, so the gallery could not be read.</p>
          <p className="mt-1">{at ? `Try again after ${at}.` : 'Try again in a little while.'}</p>
        </Notice>
      );
    }
    return (
      <Notice>
        <p>The gallery could not be reached.</p>
        <p className="mt-1">Check the connection and reload.</p>
      </Notice>
    );
  }

  if (!result.maps.length) {
    return (
      <Notice>
        <p>No maps yet.</p>
        <Link href="/" className="text-[color:var(--ink)] underline underline-offset-2">
          Build the first one.
        </Link>
      </Notice>
    );
  }

  return (
    <ul className="gallery-grid">
      {result.maps.map((map) => (
        <Card key={map.number} map={map} />
      ))}
    </ul>
  );
}
