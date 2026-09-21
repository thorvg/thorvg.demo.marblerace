/**
 * Where feedback is hosted.
 *
 * giscus posts into a GitHub Discussion, so GitHub holds the identities, the
 * moderation and the notifications, and there is no comment store of ours to
 * deploy or look after.
 *
 * These are configuration, not secrets — every site running giscus carries them
 * in plain sight in its page source. The two ids are minted by GitHub: to point
 * a fork at its own repository, switch Discussions on, install
 * https://github.com/apps/giscus, then read the pair off https://giscus.app.
 */

export const GISCUS = {
  repo: 'OSSCA-thorvg/thor-pinball',
  repoId: 'R_kgDOUQBOog',
  category: 'General',
  categoryId: 'DIC_kwDOUQBOos4DFBuv',
} as const;
