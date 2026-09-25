/**
 * The map gallery.
 *
 * A thin shell: the list reads GitHub from the browser when it mounts, so this
 * page needs no data of its own, no build step and nothing at runtime.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import BrandMark from '../../components/BrandMark';
import GalleryList from '../../components/GalleryList';
import { galleryIssuesUrl } from '../../lib/gallery';

export const metadata: Metadata = {
  title: 'Gallery — ThorVG Pinrace',
  description: 'Tracks built in the map editor and shared by the people who made them.',
};

export default function GalleryPage() {
  return (
    <main className="app-shell mx-auto flex min-h-screen w-full max-w-[1180px] flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-3 transition hover:opacity-80">
          <BrandMark />
          <h1 className="text-[22px] font-semibold tracking-tight sm:text-[25px]">Gallery</h1>
        </Link>

        <div className="flex items-center gap-2">
          <a className="btn-ghost px-3 py-[7px] text-xs" href={galleryIssuesUrl()} target="_blank" rel="noreferrer">
            Submissions on GitHub
          </a>
          <Link className="btn-primary px-3 py-[7px] text-xs" href="/">
            Build one
          </Link>
        </div>
      </header>

      <div className="bolt-rule -mt-2" aria-hidden="true" />

      <GalleryList />

      <footer className="pb-3 text-center text-[11px] leading-relaxed text-[color:var(--ink-dim)]">
        Thor Pinrace powered by ThorVG Engine
      </footer>
    </main>
  );
}
