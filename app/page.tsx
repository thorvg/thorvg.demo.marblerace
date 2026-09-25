/**
 * The page is a server shell so a shared link can describe itself: the query
 * that sets up the run also drives the title, the description and the preview
 * card. Everything interactive lives in the client component below it.
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Pinball from './Pinball';
import { getMessages } from '../lib/i18n';
import { readSharedRun } from '../lib/share';

type Params = Record<string, string | string[] | undefined>;

/**
 * Crawlers need an absolute URL. The deployment host is whatever is serving
 * the request unless it has been pinned, so it is read back off the request.
 */
async function siteUrl(): Promise<string> {
  const pinned = process.env.NEXT_PUBLIC_SITE_URL;
  if (pinned) return pinned.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;

  const head = await headers();
  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:3003';
  const proto = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Params>;
}): Promise<Metadata> {
  const params = await searchParams;
  const run = readSharedRun(params);
  const t = getMessages(run.locale);
  const base = await siteUrl();

  // The card is drawn from the same query, so the preview matches what opens.
  const card = new URLSearchParams();
  if (run.names.length) card.set('names', run.names.join(','));
  card.set('seed', run.seed);
  card.set('track', run.track);
  card.set('lang', run.locale);

  const title = run.names.length
    ? `Thor Marble Race · ${t.run.runners(run.names.length)}`
    : 'Thor Marble Race';
  const description = run.names.length
    ? `${run.names.slice(0, 6).join(', ')}${run.names.length > 6 ? '…' : ''} — ${t.settings.tracks[run.track].label}, ${run.seed}`
    : t.roster.hint;

  const image = `${base}/og?${card.toString()}`;

  return {
    metadataBase: new URL(base),
    title,
    description,
    openGraph: {
      type: 'website',
      title,
      description,
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  };
}

export default function Page() {
  return <Pinball />;
}
