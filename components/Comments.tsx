'use client';

import { useEffect, useRef } from 'react';

/** The giscus widget. Its configuration lives in `lib/comments`. */

import { GISCUS } from '../lib/comments';

/**
 * The discussion every page posts into. A fixed term rather than the pathname,
 * so the site has one thread of feedback instead of one per route.
 */
const TERM = 'Site feedback';

export default function Comments({ lang = 'en', term = TERM }: { lang?: string; term?: string }) {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = holder.current;
    if (!node) return;

    // Coming back from a sign in, giscus has appended its token to the URL and
    // needs to be running to pick it up — waiting for a scroll would leave the
    // visitor looking at a page that seems to have ignored the login.
    const returning = new URLSearchParams(window.location.search).has('giscus');

    const script = document.createElement('script');
    script.src = 'https://giscus.app/client.js';
    script.async = true;
    script.crossOrigin = 'anonymous';

    const attributes: Record<string, string> = {
      'data-repo': GISCUS.repo,
      'data-repo-id': GISCUS.repoId,
      'data-category': GISCUS.category,
      'data-category-id': GISCUS.categoryId,
      'data-mapping': 'specific',
      'data-term': term,
      'data-strict': '0',
      'data-reactions-enabled': '1',
      'data-emit-metadata': '0',
      'data-input-position': 'top',
      'data-theme': 'transparent_dark',
      'data-lang': lang === 'ko' ? 'ko' : 'en',
      'data-loading': returning ? 'eager' : 'lazy',
    };
    for (const [key, value] of Object.entries(attributes)) script.setAttribute(key, value);

    node.appendChild(script);
    if (returning) node.scrollIntoView({ block: 'center' });
    // The widget is an iframe giscus injects beside the script, so clearing the
    // holder is what actually tears it down when the language changes.
    return () => {
      node.innerHTML = '';
    };
  }, [lang, term]);

  return <div ref={holder} className="giscus-holder" />;
}
