/**
 * A read-only ZIP reader, just enough for dotLottie.
 *
 * The platform supplies the hard part — `DecompressionStream('deflate-raw')`
 * is the same decompressor the browser uses for the network — so all that is
 * left is the container: find the central directory, walk its entries, and
 * hand back the bytes of the ones asked for. That keeps a bundled inflate
 * implementation out of the app for the sake of one file format.
 *
 * Only what a dotLottie actually uses is supported: stored and deflated
 * entries, no encryption, no spanning, no zip64. Anything else throws, which
 * the caller reports as a file it could not unpack.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The comment can run to 64k, so the record is looked for within that window. */
const EOCD_SEARCH = 0xffff + 22;

const STORED = 0;
const DEFLATED = 8;

/** Marks a size that only zip64 can express, which is past what this reads. */
const ZIP64_MARKER = 0xffffffff;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the local header, which is where the data has to be found from. */
  headerOffset: number;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new Error('no deflate support');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ZipArchive {
  #bytes: Uint8Array;
  #view: DataView;
  #entries = new Map<string, Entry>();

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  static open(bytes: Uint8Array): ZipArchive {
    const archive = new ZipArchive(bytes);
    archive.#readCentralDirectory();
    return archive;
  }

  static looksLikeZip(bytes: Uint8Array): boolean {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  get names(): string[] {
    return [...this.#entries.keys()];
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  #readCentralDirectory(): void {
    const view = this.#view;
    const limit = Math.max(0, view.byteLength - EOCD_SEARCH);

    let eocd = -1;
    for (let i = view.byteLength - 22; i >= limit; i--) {
      if (view.getUint32(i, true) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip');

    const count = view.getUint16(eocd + 10, true);
    const directoryOffset = view.getUint32(eocd + 16, true);
    if (directoryOffset === ZIP64_MARKER) throw new Error('zip64 not supported');

    let at = directoryOffset;
    for (let i = 0; i < count; i++) {
      if (at + 46 > view.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) break;

      const method = view.getUint16(at + 10, true);
      const compressedSize = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const headerOffset = view.getUint32(at + 42, true);

      if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER) throw new Error('zip64 not supported');

      const name = new TextDecoder().decode(this.#bytes.subarray(at + 46, at + 46 + nameLength));
      this.#entries.set(name, { name, method, compressedSize, size, headerOffset });

      at += 46 + nameLength + extraLength + commentLength;
    }
  }

  async read(name: string): Promise<Uint8Array | null> {
    const entry = this.#entries.get(name);
    if (!entry) return null;

    const view = this.#view;
    const header = entry.headerOffset;
    if (header + 30 > view.byteLength || view.getUint32(header, true) !== LOCAL_SIGNATURE) return null;

    // The local header carries its own name and extra lengths, which need not
    // match the central directory's, so the data offset comes from here.
    const nameLength = view.getUint16(header + 26, true);
    const extraLength = view.getUint16(header + 28, true);
    const start = header + 30 + nameLength + extraLength;
    const data = this.#bytes.subarray(start, start + entry.compressedSize);

    if (entry.method === STORED) return data;
    if (entry.method === DEFLATED) return inflateRaw(data);
    throw new Error(`unsupported compression: ${entry.method}`);
  }

  async text(name: string): Promise<string | null> {
    const bytes = await this.read(name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
}
