/**
 * Fixed dimensions of the play field.
 *
 * Every course, generated or hand drawn, is laid out inside this box. It lives
 * on its own so the map blueprint can clamp against it without pulling in the
 * procedural generator.
 */

export const COURSE = {
  width: 760,
  left: 46,
  right: 714,
  releaseY: 150,
  /** Camera reference box: at zoom 1 this much of the world fits on screen. */
  viewWidth: 760,
  viewHeight: 1120,
} as const;
