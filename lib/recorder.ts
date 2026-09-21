/**
 * Canvas recording.
 *
 * The stream is taken in manual frame mode and a frame is pushed right after
 * each ThorVG render, so the recording carries exactly the frames that were
 * drawn rather than whatever the compositor happened to hold.
 */

const MIME_CANDIDATES = [
  { type: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4' },
  { type: 'video/webm;codecs=vp9', extension: 'webm' },
  { type: 'video/webm;codecs=vp8', extension: 'webm' },
  { type: 'video/webm', extension: 'webm' },
];

export interface RecordedVideo {
  blob: Blob;
  extension: string;
}

function pickMime(): { type: string; extension: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate.type)) ?? null;
}

export function isRecordingSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof HTMLCanvasElement === 'undefined') return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
  return pickMime() !== null;
}

export class CanvasRecorder {
  #canvas: HTMLCanvasElement;
  #recorder: MediaRecorder | null = null;
  #track: CanvasCaptureMediaStreamTrack | null = null;
  #chunks: Blob[] = [];
  #extension = 'webm';

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  get recording(): boolean {
    return this.#recorder?.state === 'recording';
  }

  /** Returns false when the browser will not record this canvas. */
  start(): boolean {
    if (this.recording) return true;

    const mime = pickMime();
    if (!mime) return false;

    try {
      // 0 fps means "only the frames I ask for".
      const stream = this.#canvas.captureStream(0);
      const [track] = stream.getVideoTracks();
      if (!track || typeof (track as CanvasCaptureMediaStreamTrack).requestFrame !== 'function') return false;

      this.#track = track as CanvasCaptureMediaStreamTrack;
      this.#chunks = [];
      this.#extension = mime.extension;

      const recorder = new MediaRecorder(stream, { mimeType: mime.type, videoBitsPerSecond: 9_000_000 });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.#chunks.push(event.data);
      };
      recorder.start();
      this.#recorder = recorder;
      return true;
    } catch (err) {
      console.warn('[thorvg-pinrace] canvas recording could not start:', err);
      this.#recorder = null;
      this.#track = null;
      return false;
    }
  }

  /** Hands the current canvas contents to the encoder. */
  frame(): void {
    if (!this.recording) return;
    try {
      this.#track?.requestFrame();
    } catch {
      // A dropped frame is not worth breaking the run over.
    }
  }

  /** Ends the recording and resolves with the file, or null if there is none. */
  stop(): Promise<RecordedVideo | null> {
    const recorder = this.#recorder;
    this.#recorder = null;

    if (!recorder || recorder.state === 'inactive') {
      this.#release();
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      recorder.onstop = () => {
        const chunks = this.#chunks;
        this.#chunks = [];
        this.#release();
        if (!chunks.length) {
          resolve(null);
          return;
        }
        resolve({ blob: new Blob(chunks, { type: recorder.mimeType }), extension: this.#extension });
      };
      recorder.stop();
    });
  }

  /** Ends the recording and throws the frames away. */
  cancel(): void {
    const recorder = this.#recorder;
    this.#recorder = null;
    this.#chunks = [];

    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      try {
        recorder.stop();
      } catch {
        // Already stopping.
      }
    }
    this.#release();
  }

  #release(): void {
    this.#track?.stop();
    this.#track = null;
  }
}

/** Hands the file to the browser as a download. */
export function saveVideo(video: RecordedVideo, name: string): void {
  const url = URL.createObjectURL(video.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.${video.extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to take the blob before dropping it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
