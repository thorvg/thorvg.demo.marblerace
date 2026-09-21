/**
 * A map at a glance, drawn straight from its blueprint.
 *
 * Plain SVG and nothing else: no engine, no canvas, no WASM, so a gallery card
 * renders on the server at build time. The scale is deliberately non-uniform —
 * a Marathon track is twenty times taller than it is wide, so the length is
 * squashed to fit and every piece is drawn at a fixed size instead. What that
 * gives up in accuracy it wins back in legibility: what the card shows is where
 * the machinery clusters and how the lanes run.
 */

import { COURSE } from '../lib/board';
import { boundsOf, reachOf, type Blueprint } from '../lib/blueprint';

const WIDTH = 96;
const HEIGHT = 208;
const PAD = 4;

/** Fixed sizes, so a piece stays visible however long the track is. */
const DOT = { peg: 1.1, bumper: 1.9, machine: 2.4 };

interface MiniMapProps {
  blueprint: Blueprint;
  className?: string;
}

export default function MiniMap({ blueprint, className }: MiniMapProps) {
  const height = blueprint.finishY + 260;
  const sx = (WIDTH - PAD * 2) / COURSE.width;
  const sy = (HEIGHT - PAD * 2) / Math.max(height, 1);
  const x = (value: number) => PAD + value * sx;
  const y = (value: number) => PAD + value * sy;

  const pegs: string[] = [];
  const bumpers: string[] = [];
  const machines: string[] = [];
  const walls: string[] = [];
  const pads: string[] = [];

  for (const item of blueprint.items) {
    switch (item.kind) {
      case 'peg':
        (item.bumper ? bumpers : pegs).push(`M${x(item.x)} ${y(item.y)}h.01`);
        break;
      case 'wall':
        walls.push(`M${x(item.x1)} ${y(item.y1)}L${x(item.x2)} ${y(item.y2)}`);
        break;
      case 'booster': {
        const box = boundsOf(item);
        pads.push(
          `M${x(box.x0)} ${y(box.y0)}H${x(box.x1)}V${y(box.y1)}H${x(box.x0)}Z`,
        );
        break;
      }
      case 'decal':
        break;
      default:
        machines.push(`M${x(item.x)} ${y(item.y)}h.01`);
        // The reach is what a spinner actually occupies, so it earns a ring.
        if (reachOf(item) > 90) {
          machines.push(`M${x(item.x - 6)} ${y(item.y)}h.01M${x(item.x + 6)} ${y(item.y)}h.01`);
        }
        break;
    }
  }

  const finishY = y(blueprint.finishY);
  const line = (paths: string[]) => paths.join('');

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className={className}
      role="img"
      aria-label="Track overview"
    >
      <rect width={WIDTH} height={HEIGHT} rx="8" fill="#0d0f13" />

      {/* Side rails, the frame everything else reads against. */}
      <path
        d={`M${x(COURSE.left)} ${PAD}V${HEIGHT - PAD}M${x(COURSE.right)} ${PAD}V${HEIGHT - PAD}`}
        stroke="#39414a"
        strokeWidth="1.2"
      />

      {pads.length > 0 && <path d={line(pads)} fill="rgba(0, 240, 156, 0.16)" stroke="#00f09c" strokeWidth="0.5" />}
      {walls.length > 0 && <path d={line(walls)} stroke="#7c8e9c" strokeWidth="1" strokeLinecap="round" />}
      {pegs.length > 0 && (
        <path d={line(pegs)} stroke="#93a2b0" strokeWidth={DOT.peg * 2} strokeLinecap="round" />
      )}
      {machines.length > 0 && (
        <path d={line(machines)} stroke="#2ea8b8" strokeWidth={DOT.machine * 2} strokeLinecap="round" />
      )}
      {bumpers.length > 0 && (
        <path d={line(bumpers)} stroke="#fb832e" strokeWidth={DOT.bumper * 2} strokeLinecap="round" />
      )}

      <path
        d={`M${x(COURSE.left)} ${finishY}H${x(COURSE.right)}`}
        stroke="#f5c04e"
        strokeWidth="1.4"
        strokeDasharray="3 2"
      />
    </svg>
  );
}
