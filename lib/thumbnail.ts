/**
 * A still of a Lottie's first frame, for the roster chip.
 *
 * The chip is DOM, so it cannot host a running animation cheaply; instead the
 * artwork is rendered once on a detached ThorVG canvas and kept as a PNG data
 * URI alongside the skin.
 */

import type { Animation, Canvas, RendererType, ThorVGNamespace } from '@thorvg/webcanvas';
import { skinPayload, type Skin } from './skins';

const SIZE = 96;

let seq = 0;

/**
 * WebGL throws the drawing buffer away after compositing, so the context is
 * created here with preserveDrawingBuffer before ThorVG asks for it: a canvas
 * hands back the context it already has, with the attributes it was made with.
 * Only for GL - claiming a context the software backend cannot use would leave
 * it without the 2D one it blits through.
 */
function preserveBuffer(canvas: HTMLCanvasElement, renderer: RendererType): void {
  if (renderer !== 'gl') return;
  try {
    const options = { preserveDrawingBuffer: true, alpha: true, antialias: true };
    canvas.getContext('webgl2', options) ?? canvas.getContext('webgl', options);
  } catch {
    // The backend will make its own.
  }
}

/** Renders frame 0 of a Lottie skin, or null when it cannot be drawn. */
export function renderLottieThumb(tvg: ThorVGNamespace, renderer: RendererType, skin: Skin): string | null {
  if (skin.type !== 'lot') return null;

  const payload = skinPayload(skin);
  if (typeof payload !== 'string') return null;

  const id = `skin-thumb-${seq++}`;
  const element = document.createElement('canvas');
  element.id = id;
  element.width = SIZE;
  element.height = SIZE;
  element.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none';
  document.body.appendChild(element);
  preserveBuffer(element, renderer);

  let canvas: Canvas | null = null;
  let animation: Animation | null = null;

  try {
    canvas = new tvg.Canvas(`#${id}`, { width: SIZE, height: SIZE });
    animation = new tvg.Animation();
    animation.load(payload);

    const picture = animation.picture;
    if (!picture) return null;

    picture.size(SIZE, SIZE);
    // A freshly loaded animation already sits on frame 0.
    canvas.add(picture);
    canvas.update().render();

    const url = element.toDataURL('image/png');
    // A canvas that rendered nothing serialises to a handful of bytes.
    return url.length > 512 ? url : null;
  } catch (err) {
    console.warn('[thorvg-pinrace] lottie thumbnail could not be rendered:', err);
    return null;
  } finally {
    try {
      animation?.dispose();
      canvas?.destroy();
    } catch {
      // Already gone.
    }
    element.remove();
  }
}
