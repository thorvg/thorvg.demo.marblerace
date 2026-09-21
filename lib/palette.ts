/** Colour system for the board, the marbles and the reveal. */

import type { RGB } from './types';

/**
 * Runner colours, drawn from the ThorVG bolt spectrum (azure, cyan, mint,
 * lime, amber, orange, red). Neighbouring indices always come from different
 * families so two runners are never hard to tell apart.
 */
export const MARBLE_COLORS: readonly RGB[] = [
  [0, 144, 216],
  [251, 131, 46],
  [0, 240, 156],
  [245, 192, 78],
  [0, 192, 192],
  [240, 62, 7],
  [183, 205, 111],
  [77, 180, 232],
  [255, 171, 107],
  [13, 189, 124],
  [255, 217, 138],
  [85, 216, 216],
  [255, 122, 82],
  [138, 163, 71],
  [26, 122, 186],
  [209, 101, 15],
  [107, 245, 192],
  [214, 154, 42],
  [16, 154, 154],
  [211, 225, 154],
];

export interface UiPalette {
  frame: RGB;
  peg: RGB;
  pegLight: RGB;
  track: RGB;
  trackLight: RGB;
  machine: RGB;
  bumper: RGB;
  bumperLight: RGB;
  hot: RGB;
  boost: RGB;
  goal: RGB;
  gold: RGB;
  finish: RGB;
  text: RGB;
  textDim: RGB;
}

export const UI: UiPalette = {
  // Structure stays graphite so the brand colours only appear where something
  // is meant to catch the eye.
  frame: [51, 60, 70] as RGB,
  peg: [57, 65, 74] as RGB,
  pegLight: [147, 162, 176] as RGB,
  track: [51, 60, 70] as RGB,
  trackLight: [124, 142, 156] as RGB,
  // Energy: straight out of the bolt.
  machine: [46, 168, 184] as RGB,
  bumper: [251, 131, 46] as RGB,
  bumperLight: [255, 208, 160] as RGB,
  hot: [251, 131, 46] as RGB,
  boost: [0, 240, 156] as RGB,
  goal: [34, 207, 212] as RGB,
  gold: [245, 192, 78] as RGB,
  finish: [242, 245, 247] as RGB,
  text: [232, 236, 239] as RGB,
  textDim: [125, 138, 148] as RGB,
};

/** Hue cycle used by the animated backdrop, following the bolt spectrum. */
export const AURORA: readonly RGB[] = [
  [0, 144, 216],
  [0, 192, 192],
  [0, 240, 156],
  [245, 192, 78],
  [240, 62, 7],
];

export function marbleColor(index: number): RGB {
  return MARBLE_COLORS[index % MARBLE_COLORS.length];
}

/** Blend towards white by `amount` (0..1). */
export function lighten(c: RGB, amount: number): RGB {
  return [
    Math.round(c[0] + (255 - c[0]) * amount),
    Math.round(c[1] + (255 - c[1]) * amount),
    Math.round(c[2] + (255 - c[2]) * amount),
  ];
}

/** Blend towards black by `amount` (0..1). */
export function darken(c: RGB, amount: number): RGB {
  return [Math.round(c[0] * (1 - amount)), Math.round(c[1] * (1 - amount)), Math.round(c[2] * (1 - amount))];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function css(c: RGB, alpha = 1): string {
  return alpha >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}
