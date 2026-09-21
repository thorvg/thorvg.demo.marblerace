/**
 * Map editor: the interaction model behind the drag-to-design board.
 *
 * The editor owns a blueprint and every gesture that mutates it — placing,
 * picking, moving, resizing, rubber band selection, undo. It knows nothing
 * about the DOM or about ThorVG: the stage feeds it world coordinates and the
 * editor layer draws whatever `snapshot()` reports, so the same model drives
 * mouse, touch and keyboard alike.
 *
 * History is snapshot based. A snapshot is taken at the start of a gesture, not
 * at the end, so an interrupted drag still undoes to the state before it.
 */

import {
  FIELDS,
  createDecal,
  cloneItem,
  decalsOf,
  FINISH_MAX,
  FINISH_MIN,
  boundsOf,
  cloneBlueprint,
  cloneItems,
  createItem,
  distanceToItem,
  emptyBlueprint,
  handlesOf,
  dragHandle,
  moveItem,
  newId,
  setField,
  type Blueprint,
  type Box,
  type DecalItem,
  type Handle,
  type ItemKind,
  type MapItem,
  type ToolKind,
} from './blueprint';
import type { Skin, SkinError } from './skins';

export type Tool = 'select' | ToolKind;

/** Pseudo item id for the draggable finish line. */
export const FINISH_ID = '#finish';

const HISTORY_LIMIT = 200;
/** Pick tolerance and handle size, in screen pixels. */
const PICK_SLACK = 7;
const HANDLE_HIT = 9;
export const HANDLE_SIZE = 5.5;
/** A press shorter than this in world units still counts as a click. */
const CLICK_SLOP = 3;

export interface PointerInput {
  x: number;
  y: number;
  /** Canvas pixels per world unit, so hit areas stay constant on screen. */
  scale: number;
  shift: boolean;
  /** Held to bypass the grid. */
  alt: boolean;
  /** Command on macOS, Control elsewhere. */
  meta: boolean;
}

export interface Target {
  id: string;
  handle?: string;
}

/** Why a dropped file did not become artwork. */
export type DropNote = SkinError;

interface Snapshot {
  items: MapItem[];
  finishY: number;
}

type Drag = { recorded: boolean } & (
  | { mode: 'move'; anchorId: string; grabX: number; grabY: number; origin: Map<string, MapItem>; moved: boolean }
  | { mode: 'handle'; id: string; handle: string }
  | { mode: 'marquee'; x0: number; y0: number; additive: boolean }
  | { mode: 'finish'; offset: number }
);

/** Everything the editor layer needs to draw a frame. */
export interface EditorFrame {
  items: readonly MapItem[];
  selected: ReadonlySet<string>;
  hover: string | null;
  handles: readonly Handle[];
  marquee: Box | null;
  ghost: MapItem | null;
  decals: readonly DecalItem[];
  grid: number;
  finishY: number;
  height: number;
  finishActive: boolean;
}

export class MapEditor {
  #blueprint: Blueprint = emptyBlueprint();
  #selection = new Set<string>();
  #tool: Tool = 'select';
  #hover: string | null = null;
  #hoverHandle: string | null = null;
  #grid = 10;
  #snap = true;
  #showGrid = true;

  #past: Snapshot[] = [];
  #future: Snapshot[] = [];
  /** Coalesces repeated keystrokes and slider drags into one history entry. */
  #coalesce: { tag: string; at: number } | null = null;

  #drag: Drag | null = null;
  /** True once the gesture in flight has written an undo entry. */
  #gestureDirty = false;
  #pointer: PointerInput | null = null;
  #ghost: MapItem | null = null;
  #note: DropNote | null = null;
  #handles: Handle[] = [];
  #frame: EditorFrame;

  #version = 0;
  #listeners = new Set<() => void>();

  constructor(blueprint?: Blueprint) {
    if (blueprint) this.#blueprint = cloneBlueprint(blueprint);
    this.#frame = {
      items: this.#blueprint.items,
      selected: this.#selection,
      hover: null,
      handles: this.#handles,
      marquee: null,
      ghost: null,
      decals: [],
      grid: 0,
      finishY: this.#blueprint.finishY,
      height: this.#blueprint.finishY + 260,
      finishActive: false,
    };
  }

  /* ----------------------------------------------------------- observing */

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Bumped on every change, so React can re-read through useSyncExternalStore. */
  getVersion = (): number => this.#version;

  #touch(): void {
    // Handles are derived state, so they are rebuilt wherever the document or
    // the selection moved rather than at every call site that changes one.
    this.#rebuildHandles();
    this.#version++;
    for (const listener of this.#listeners) listener();
  }

  /* ------------------------------------------------------------ document */

  get blueprint(): Blueprint {
    return this.#blueprint;
  }

  /** A detached copy, safe to store or serialise. */
  snapshotBlueprint(): Blueprint {
    return cloneBlueprint(this.#blueprint);
  }

  load(blueprint: Blueprint): void {
    this.#blueprint = cloneBlueprint(blueprint);
    this.#selection.clear();
    this.#past = [];
    this.#future = [];
    this.#drag = null;
    this.#ghost = null;
    this.#hover = null;
    this.#note = null;
    this.#touch();
  }

  /**
   * Replaces the contents but keeps the undo trail, for regenerating a track.
   *
   * @param keepArtwork carries any dropped decals across. Re-rolling the track
   * should not throw away artwork the user placed by hand; importing a map
   * file should, because the file brings its own.
   */
  replace(blueprint: Blueprint, keepArtwork = false): void {
    this.#record('replace');
    this.#seal();

    const carried = keepArtwork ? decalsOf(this.#blueprint.items).map(cloneItem) : [];
    this.#blueprint.items = [...carried, ...cloneItems(blueprint.items)];
    this.#blueprint.marks = blueprint.marks.map((mark) => ({ ...mark }));
    this.#blueprint.finishY = blueprint.finishY;
    this.#blueprint.seed = blueprint.seed;
    this.#selection.clear();
    this.#touch();
  }

  get itemCount(): number {
    return this.#blueprint.items.length;
  }

  /** Total track length, finish line plus the run out below it. */
  get courseHeight(): number {
    return this.#blueprint.finishY + 260;
  }

  get finishY(): number {
    return this.#blueprint.finishY;
  }

  counts(): Record<ItemKind, number> {
    const tally: Record<ItemKind, number> = { peg: 0, wall: 0, spinner: 0, pendulum: 0, slider: 0, booster: 0, decal: 0 };
    for (const item of this.#blueprint.items) tally[item.kind]++;
    return tally;
  }

  /**
   * Adds dropped artwork to the board as scenery, one undo step for the whole
   * drop. Later files are nudged along so a multi file drop does not stack
   * every piece on the same spot.
   */
  addDecals(art: Array<{ skin: Skin; width: number; height: number }>, x: number, y: number): void {
    if (!art.length) return;
    this.#record('drop');
    this.#seal();

    const added: DecalItem[] = [];
    art.forEach((entry, index) => {
      const step = index * 24;
      const decal = createDecal(entry.skin, x + step, y + step, entry.width, entry.height);
      this.#blueprint.items.push(decal);
      added.push(decal);
    });

    this.#selection.clear();
    for (const decal of added) this.#selection.add(decal.id);
    this.#tool = 'select';
    this.#ghost = null;
    this.#touch();
  }

  /** Last thing that went wrong with a drop, for the panel to report. */
  get note(): DropNote | null {
    return this.#note;
  }

  setNote(note: DropNote | null): void {
    this.#note = note;
    this.#touch();
  }

  /* ------------------------------------------------------------- history */

  /**
   * Stores the state a gesture is about to change. Repeated calls with the same
   * tag inside a short window fold into the first, so holding an arrow key or
   * dragging a slider is one undo step, not fifty.
   */
  #record(tag: string): void {
    const now = Date.now();
    this.#gestureDirty = true;
    if (this.#coalesce && this.#coalesce.tag === tag && now - this.#coalesce.at < 700) {
      this.#coalesce.at = now;
      return;
    }
    this.#coalesce = { tag, at: now };
    this.#past.push({ items: cloneItems(this.#blueprint.items), finishY: this.#blueprint.finishY });
    if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
    this.#future = [];
  }

  /** Ends a coalescing window, so the next change starts a fresh undo step. */
  #seal(): void {
    this.#coalesce = null;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  undo(): void {
    const previous = this.#past.pop();
    if (!previous) return;
    this.#future.push({ items: cloneItems(this.#blueprint.items), finishY: this.#blueprint.finishY });
    this.#apply(previous);
  }

  redo(): void {
    const next = this.#future.pop();
    if (!next) return;
    this.#past.push({ items: cloneItems(this.#blueprint.items), finishY: this.#blueprint.finishY });
    this.#apply(next);
  }

  #apply(state: Snapshot): void {
    this.#blueprint.items = state.items;
    this.#blueprint.finishY = state.finishY;
    this.#drag = null;
    this.#gestureDirty = false;
    this.#seal();
    // Anything the undo removed cannot stay selected.
    const live = new Set(state.items.map((item) => item.id));
    for (const id of [...this.#selection]) {
      if (id !== FINISH_ID && !live.has(id)) this.#selection.delete(id);
    }
    this.#touch();
  }

  /* ----------------------------------------------------------- selection */

  get tool(): Tool {
    return this.#tool;
  }

  setTool(tool: Tool): void {
    if (this.#tool === tool) return;
    this.#tool = tool;
    this.#ghost = null;
    if (tool !== 'select') this.#selection.clear();
    this.#touch();
  }

  get selection(): ReadonlySet<string> {
    return this.#selection;
  }

  selectedItems(): MapItem[] {
    return this.#blueprint.items.filter((item) => this.#selection.has(item.id));
  }

  /** The one kind the whole selection shares, or null for a mixed bag. */
  selectedKind(): ItemKind | null {
    const items = this.selectedItems();
    if (!items.length) return null;
    const kind = items[0].kind;
    return items.every((item) => item.kind === kind) ? kind : null;
  }

  select(ids: readonly string[], additive = false): void {
    if (!additive) this.#selection.clear();
    for (const id of ids) this.#selection.add(id);
    this.#touch();
  }

  selectAll(): void {
    this.#selection.clear();
    for (const item of this.#blueprint.items) this.#selection.add(item.id);
    this.#touch();
  }

  clearSelection(): void {
    if (!this.#selection.size) return;
    this.#selection.clear();
    this.#touch();
  }

  /* ------------------------------------------------------------ mutation */

  deleteSelection(): void {
    if (!this.#selection.size) return;
    this.#record('delete');
    this.#seal();
    this.#blueprint.items = this.#blueprint.items.filter((item) => !this.#selection.has(item.id));
    this.#selection.clear();
    this.#touch();
  }

  duplicateSelection(): void {
    const picked = this.selectedItems();
    if (!picked.length) return;
    this.#record('duplicate');
    this.#seal();

    const step = this.#grid > 0 ? this.#grid * 2 : 20;
    const copies = picked.map((item) => {
      const copy = { ...item, id: newId() };
      moveItem(copy, step, step);
      return copy;
    });
    this.#blueprint.items.push(...copies);
    this.#selection.clear();
    for (const copy of copies) this.#selection.add(copy.id);
    this.#touch();
  }

  nudge(dx: number, dy: number): void {
    if (!this.#selection.size) return;
    this.#record('nudge');
    for (const item of this.selectedItems()) moveItem(item, dx, dy);
    if (this.#selection.has(FINISH_ID)) this.setFinishY(this.#blueprint.finishY + dy, 'nudge');
    this.#touch();
  }

  /** Sends the selection to the front or the back of the draw order. */
  reorder(toFront: boolean): void {
    if (!this.#selection.size) return;
    this.#record('reorder');
    this.#seal();
    const picked = this.#blueprint.items.filter((item) => this.#selection.has(item.id));
    const rest = this.#blueprint.items.filter((item) => !this.#selection.has(item.id));
    this.#blueprint.items = toFront ? [...rest, ...picked] : [...picked, ...rest];
    this.#touch();
  }

  /** Applies one inspector field to every selected item that has it. */
  setFieldOn(key: string, value: number): void {
    const picked = this.selectedItems();
    if (!picked.length) return;
    this.#record(`field:${key}`);
    for (const item of picked) {
      if (FIELDS[item.kind].some((field) => field.key === key)) setField(item, key, value);
    }
    this.#touch();
  }

  /** Flips a boolean flag on the selection, matching the shared value. */
  toggleFlag(key: 'bumper' | 'hot'): void {
    const picked = this.selectedItems();
    if (!picked.length) return;
    this.#record(`flag:${key}`);
    this.#seal();

    const record = picked[0] as unknown as Record<string, unknown>;
    const next = record[key] !== true;
    for (const item of picked) {
      if (key === 'bumper' && item.kind === 'peg') {
        item.bumper = next;
        // A peg still on the default radius follows the swap, so the change reads.
        if (next && item.r === 11) item.r = 21;
        else if (!next && item.r === 21) item.r = 11;
      } else if (key === 'hot' && item.kind === 'spinner') {
        item.hot = next;
      }
    }
    this.#touch();
  }

  setFinishY(y: number, tag = 'finish'): void {
    this.#record(tag);
    this.#blueprint.finishY = Math.max(FINISH_MIN, Math.min(FINISH_MAX, Math.round(y)));
    this.#touch();
  }

  /** Drops every item, keeping the board and the finish line. */
  clearItems(): void {
    if (!this.#blueprint.items.length) return;
    this.#record('clear');
    this.#seal();
    this.#blueprint.items = [];
    this.#selection.clear();
    this.#touch();
  }

  /* --------------------------------------------------------------- grid */

  get grid(): number {
    return this.#grid;
  }

  get snapEnabled(): boolean {
    return this.#snap;
  }

  get showGrid(): boolean {
    return this.#showGrid;
  }

  setGrid(size: number): void {
    this.#grid = Math.max(1, Math.min(80, Math.round(size)));
    this.#touch();
  }

  setSnap(on: boolean): void {
    this.#snap = on;
    this.#touch();
  }

  setShowGrid(on: boolean): void {
    this.#showGrid = on;
    this.#touch();
  }

  #snapValue(value: number): number {
    if (!this.#snap || this.#grid <= 0 || this.#pointer?.alt) return value;
    return Math.round(value / this.#grid) * this.#grid;
  }

  /* ------------------------------------------------------------- picking */

  /** Topmost thing under a world point, handles of the selection first. */
  pick(input: PointerInput): Target | null {
    const items = this.#blueprint.items;
    const handleReach = HANDLE_HIT / input.scale;

    for (const handle of this.#handles) {
      if (Math.abs(input.x - handle.x) <= handleReach && Math.abs(input.y - handle.y) <= handleReach) {
        return { id: this.#handleOwner(handle.id) ?? '', handle: handle.id };
      }
    }

    const slack = PICK_SLACK / input.scale;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'decal') continue;
      if (distanceToItem(items[i], input.x, input.y) <= slack) return { id: items[i].id };
    }

    // The finish line spans the board, so it only wins over the scenery.
    if (Math.abs(input.y - this.#blueprint.finishY) <= 16 / input.scale) return { id: FINISH_ID };

    // Artwork is picked last: it is usually the largest thing on the board and
    // would otherwise swallow every click on the pieces sitting over it.
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind !== 'decal') continue;
      if (distanceToItem(items[i], input.x, input.y) <= slack) return { id: items[i].id };
    }
    return null;
  }

  #handleOwner(handleId: string): string | null {
    const separator = handleId.indexOf(':');
    return separator > 0 ? handleId.slice(0, separator) : null;
  }

  #rebuildHandles(): void {
    this.#handles.length = 0;
    // Handles only make sense on a single item; a multi selection is moved whole.
    if (this.#selection.size !== 1) return;
    const [id] = this.#selection;
    if (id === FINISH_ID) return;
    const item = this.#blueprint.items.find((entry) => entry.id === id);
    if (!item) return;
    for (const handle of handlesOf(item)) {
      this.#handles.push({ ...handle, id: `${item.id}:${handle.id}` });
    }
  }

  /* -------------------------------------------------------------- input */

  get cursor(): string {
    if (this.#drag?.mode === 'move') return 'grabbing';
    if (this.#drag) return 'crosshair';
    if (this.#tool !== 'select') return 'crosshair';
    if (this.#hoverHandle) {
      return this.#handles.find((handle) => handle.id === this.#hoverHandle)?.cursor ?? 'pointer';
    }
    if (this.#hover === FINISH_ID) return 'ns-resize';
    if (this.#hover) return 'grab';
    return 'default';
  }

  pointerDown(input: PointerInput): void {
    this.#pointer = input;
    this.#gestureDirty = false;
    this.#seal();

    if (this.#tool !== 'select') {
      this.#placeAt(input);
      return;
    }

    const target = this.pick(input);

    if (!target) {
      // Empty board: start a rubber band. A plain press also clears the selection.
      if (!input.shift) this.#selection.clear();
      this.#drag = { mode: 'marquee', recorded: true, x0: input.x, y0: input.y, additive: input.shift };
      this.#touch();
      return;
    }

    if (target.handle) {
      this.#drag = { mode: 'handle', recorded: false, id: target.id, handle: target.handle.split(':')[1] ?? '' };
      this.#touch();
      return;
    }

    if (target.id === FINISH_ID) {
      this.#selection.clear();
      this.#selection.add(FINISH_ID);
      this.#drag = { mode: 'finish', recorded: false, offset: this.#blueprint.finishY - input.y };
      this.#touch();
      return;
    }

    if (input.shift) {
      if (this.#selection.has(target.id)) this.#selection.delete(target.id);
      else this.#selection.add(target.id);
    } else if (!this.#selection.has(target.id)) {
      this.#selection.clear();
      this.#selection.add(target.id);
    }
    this.#beginMove(target.id, input, false);
    this.#touch();
  }

  #placeAt(input: PointerInput): void {
    if (this.#tool === 'select') return;
    this.#record('place');
    this.#seal();

    const item = createItem(this.#tool, this.#snapValue(input.x), this.#snapValue(input.y));
    this.#blueprint.items.push(item);
    this.#selection.clear();
    this.#selection.add(item.id);
    this.#ghost = null;
    // Placing hands straight over to a move, so a press-drag-release both
    // creates the item and puts it exactly where the pointer lets go. The
    // placement is already in history, so the move must not add a second entry.
    this.#beginMove(item.id, input, true);
    this.#touch();
  }

  #beginMove(anchorId: string, input: PointerInput, recorded: boolean): void {
    const origin = new Map<string, MapItem>();
    for (const item of this.selectedItems()) origin.set(item.id, { ...item });
    if (!origin.size) return;

    const anchor = origin.get(anchorId) ?? origin.values().next().value;
    if (!anchor) return;
    const box = boundsOf(anchor);
    this.#drag = {
      mode: 'move',
      recorded,
      anchorId: anchor.id,
      // Grab offset from the anchor's own corner, so snapping lands the item
      // on the grid rather than the pointer.
      grabX: input.x - box.x0,
      grabY: input.y - box.y0,
      origin,
      moved: false,
    };
  }

  pointerMove(input: PointerInput): void {
    this.#pointer = input;
    const drag = this.#drag;

    if (!drag) {
      if (this.#tool !== 'select') {
        // The ghost is read straight off the frame, so following the pointer
        // costs a redraw and never a React render.
        this.#ghost = createItem(this.#tool, this.#snapValue(input.x), this.#snapValue(input.y));
        return;
      }
      const target = this.pick(input);
      const hover = target?.id ?? null;
      const handle = target?.handle ?? null;
      if (hover === this.#hover && handle === this.#hoverHandle) return;
      this.#hover = hover;
      this.#hoverHandle = handle;
      this.#touch();
      return;
    }

    switch (drag.mode) {
      case 'move': {
        const anchor = drag.origin.get(drag.anchorId);
        if (!anchor) break;
        const box = boundsOf(anchor);
        const targetX = this.#snapValue(input.x - drag.grabX);
        const targetY = this.#snapValue(input.y - drag.grabY);
        const dx = targetX - box.x0;
        const dy = targetY - box.y0;
        if (!drag.moved && Math.hypot(dx, dy) > CLICK_SLOP) {
          drag.moved = true;
          // Nothing has been touched yet this gesture, so the items still hold
          // exactly the pose the undo entry should carry.
          if (!drag.recorded) {
            drag.recorded = true;
            this.#record('move');
            this.#seal();
          }
        }

        for (const [id, start] of drag.origin) {
          const item = this.#blueprint.items.find((entry) => entry.id === id);
          if (!item) continue;
          // Restored from the gesture's starting pose every frame, so a drag
          // that crosses a clamp edge and comes back does not drift.
          Object.assign(item, start);
          moveItem(item, dx, dy);
        }
        break;
      }
      case 'handle': {
        const item = this.#blueprint.items.find((entry) => entry.id === drag.id);
        if (!item) break;
        if (!drag.recorded) {
          drag.recorded = true;
          this.#record('resize');
          this.#seal();
        }
        dragHandle(item, drag.handle, this.#snapValue(input.x), this.#snapValue(input.y));
        break;
      }
      case 'marquee':
        break;
      case 'finish':
        if (!drag.recorded) {
          drag.recorded = true;
          this.#record('finish');
          this.#seal();
        }
        this.#blueprint.finishY = Math.max(
          FINISH_MIN,
          Math.min(FINISH_MAX, Math.round(this.#snapValue(input.y + drag.offset))),
        );
        break;
    }

    this.#touch();
  }

  pointerUp(input?: PointerInput): void {
    const drag = this.#drag;
    if (drag?.mode === 'marquee' && input) {
      const box: Box = {
        x0: Math.min(drag.x0, input.x),
        y0: Math.min(drag.y0, input.y),
        x1: Math.max(drag.x0, input.x),
        y1: Math.max(drag.y0, input.y),
      };
      if (!drag.additive) this.#selection.clear();
      // A band smaller than a click is a click: it should not select the board.
      if (box.x1 - box.x0 > CLICK_SLOP || box.y1 - box.y0 > CLICK_SLOP) {
        for (const item of this.#blueprint.items) {
          const bounds = boundsOf(item);
          if (bounds.x1 < box.x0 || bounds.x0 > box.x1 || bounds.y1 < box.y0 || bounds.y0 > box.y1) continue;
          this.#selection.add(item.id);
        }
      }
    }

    // A press that never moved keeps only the item under the pointer, so
    // clicking one member of a group selects it instead of the whole group.
    if (drag?.mode === 'move' && !drag.moved && !this.#pointer?.shift && this.#selection.size > 1) {
      this.#selection.clear();
      this.#selection.add(drag.anchorId);
    }

    this.#drag = null;
    this.#gestureDirty = false;
    this.#seal();
    this.#touch();
  }

  pointerLeave(): void {
    if (this.#hover === null && !this.#ghost) return;
    this.#hover = null;
    this.#hoverHandle = null;
    this.#ghost = null;
    this.#touch();
  }

  /** Cancels a gesture in flight, restoring what it had changed. */
  cancelDrag(): void {
    if (!this.#drag) return;
    const dirty = this.#gestureDirty;
    this.#drag = null;
    this.#gestureDirty = false;
    // Only a gesture that actually wrote history has anything to roll back.
    if (dirty) this.undo();
    else this.#touch();
  }

  /** @returns true when the editor consumed the key */
  keyDown(event: KeyboardEvent): boolean {
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key.toLowerCase() === 'z') {
      if (event.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      this.redo();
      return true;
    }
    if (mod && event.key.toLowerCase() === 'a') {
      this.selectAll();
      return true;
    }
    if (mod && event.key.toLowerCase() === 'd') {
      this.duplicateSelection();
      return true;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    if (event.key === 'Escape') {
      if (this.#drag) this.cancelDrag();
      else if (this.#tool !== 'select') this.setTool('select');
      else this.clearSelection();
      return true;
    }
    if (event.key.startsWith('Arrow')) {
      const step = event.shiftKey ? (this.#grid || 10) * 5 : this.#grid || 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return false;
      this.nudge(dx, dy);
      return true;
    }

    const shortcuts: Record<string, Tool> = {
      v: 'select',
      p: 'peg',
      w: 'wall',
      s: 'spinner',
      n: 'pendulum',
      b: 'slider',
      g: 'booster',
    };
    const tool = shortcuts[event.key.toLowerCase()];
    if (tool && !mod) {
      this.setTool(tool);
      return true;
    }
    return false;
  }

  /* -------------------------------------------------------------- output */

  /** Live view for the renderer. The object is reused, never reallocated. */
  frame(): EditorFrame {
    const drag = this.#drag;
    const frame = this.#frame;
    frame.items = this.#blueprint.items;
    frame.selected = this.#selection;
    frame.hover = this.#hover;
    frame.handles = this.#handles;
    frame.ghost = this.#ghost;
    frame.decals = decalsOf(this.#blueprint.items);
    frame.grid = this.#showGrid ? this.#grid : 0;
    frame.finishY = this.#blueprint.finishY;
    frame.height = this.#blueprint.finishY + 260;
    frame.finishActive = this.#selection.has(FINISH_ID) || this.#hover === FINISH_ID;

    if (drag?.mode === 'marquee' && this.#pointer) {
      frame.marquee = {
        x0: Math.min(drag.x0, this.#pointer.x),
        y0: Math.min(drag.y0, this.#pointer.y),
        x1: Math.max(drag.x0, this.#pointer.x),
        y1: Math.max(drag.y0, this.#pointer.y),
      };
    } else {
      frame.marquee = null;
    }
    return frame;
  }
}
