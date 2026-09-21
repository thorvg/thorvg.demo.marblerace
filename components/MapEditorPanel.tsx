'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import DiceIcon from './DiceIcon';
import type { Messages } from '../lib/i18n';
import {
  FIELDS,
  FINISH_MAX,
  FINISH_MIN,
  FLAGS,
  TOOL_KINDS,
  blueprintToJson,
  parseBlueprint,
  ITEM_KINDS,
  type DecalItem,
  type FieldSpec,
} from '../lib/blueprint';
import { FINISH_ID, type DropNote, type MapEditor, type Tool } from '../lib/mapEditor';

const TOOLS: Tool[] = ['select', ...TOOL_KINDS];

const SHORTCUT: Record<Tool, string> = {
  select: 'V',
  peg: 'P',
  wall: 'W',
  spinner: 'S',
  pendulum: 'N',
  slider: 'B',
  booster: 'G',
};

/** One glyph per tool, drawn in a 16 unit box. */
function ToolIcon({ tool }: { tool: Tool }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const };
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      {tool === 'select' && <path d="M3 2l9 5.2-4 .8-1.4 3.9z" fill="currentColor" />}
      {tool === 'peg' && <circle cx="8" cy="8" r="3.6" fill="currentColor" />}
      {tool === 'wall' && <path d="M2.5 11.5L13 4.5" {...stroke} strokeWidth={2.4} />}
      {tool === 'spinner' && (
        <g {...stroke}>
          <path d="M8 8V2.6M8 8l4.7 2.7M8 8L3.3 10.7" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        </g>
      )}
      {tool === 'pendulum' && (
        <g {...stroke}>
          <path d="M8 2.5v6.2" />
          <circle cx="8" cy="11.6" r="2.2" fill="currentColor" stroke="none" />
        </g>
      )}
      {tool === 'slider' && (
        <g {...stroke}>
          <path d="M3 9.6L13 6.4" strokeWidth={2.4} />
          <path d="M2 12.6h12" strokeWidth={1} opacity={0.5} />
        </g>
      )}
      {tool === 'booster' && (
        <g {...stroke}>
          <rect x="3.2" y="2.8" width="9.6" height="10.4" rx="2" />
          <path d="M5.6 6.2L8 8.6l2.4-2.4M5.6 9.4L8 11.8l2.4-2.4" />
        </g>
      )}
    </svg>
  );
}

interface MapEditorPanelProps {
  editor: MapEditor;
  messages: Messages;
  onExit: () => void;
  onRegenerate: () => void;
  onRandom: () => void;
  onZoom: (factor: number) => void;
  onLookAt: (y: number) => void;
}

export default function MapEditorPanel({
  editor,
  messages,
  onExit,
  onRegenerate,
  onRandom,
  onZoom,
  onLookAt,
}: MapEditorPanelProps) {
  const t = messages.editor;
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  // The editor is a plain object outside React, so the panel follows its
  // version counter rather than holding a copy of the document.
  useSyncExternalStore(editor.subscribe, editor.getVersion, editor.getVersion);

  const selected = editor.selectedItems();
  const kind = editor.selectedKind();
  const first = selected[0];
  const dropNote: Record<DropNote, string> = {
    size: t.dropTooBig,
    type: t.dropBadType,
    read: t.dropFailed,
    unpack: t.dropUnpack,
  };
  const finishPicked = editor.selection.has(FINISH_ID);
  const counts = editor.counts();

  const readField = (spec: FieldSpec): number => {
    const value = (first as unknown as Record<string, number>)?.[spec.key];
    return typeof value === 'number' ? value : spec.min;
  };

  const format = (spec: FieldSpec, value: number) => (spec.step < 1 ? value.toFixed(2) : String(Math.round(value)));

  const exportMap = () => {
    const blueprint = editor.snapshotBlueprint();
    const blob = new Blob([blueprintToJson(blueprint)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `thorvg-pinrace-map${blueprint.name ? `-${blueprint.name}` : ''}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const importMap = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseBlueprint(await file.text());
    if (!parsed) {
      setNote(t.importFailed);
      return;
    }
    setNote(null);
    editor.replace(parsed);
  };

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">{t.title}</h2>
        <span className="text-[11px] text-[color:var(--ink-dim)]">{t.pieces(editor.itemCount)}</span>
      </div>

      {/* Palette ------------------------------------------------------- */}
      <section>
        <p className="label">{t.toolsLabel}</p>
        <div className="tool-grid">
          {TOOLS.map((tool) => (
            <button
              key={tool}
              type="button"
              className="tool-btn"
              data-active={editor.tool === tool}
              title={`${t.tools[tool]} (${SHORTCUT[tool]})`}
              onClick={() => editor.setTool(tool)}
            >
              <ToolIcon tool={tool} />
              <span className="truncate">{t.tools[tool]}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-[color:var(--ink-dim)]">
          <svg viewBox="0 0 16 16" width="12" height="12" className="mt-[1px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
            <path d="M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2" strokeLinecap="round" />
            <path d="M8 2.5v7M5.2 6.9L8 9.7l2.8-2.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t.dropHint}
        </p>
        {editor.note && (
          <p className="mt-1.5 text-[11px]" style={{ color: '#ff8f6a' }}>
            {dropNote[editor.note]}
          </p>
        )}
      </section>

      {/* Edit actions -------------------------------------------------- */}
      <section className="grid grid-cols-4 gap-1.5">
        <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" disabled={!editor.canUndo} onClick={() => editor.undo()}>
          {t.undo}
        </button>
        <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" disabled={!editor.canRedo} onClick={() => editor.redo()}>
          {t.redo}
        </button>
        <button
          type="button"
          className="btn-ghost px-0 py-1.5 text-[11px]"
          disabled={!selected.length}
          onClick={() => editor.duplicateSelection()}
        >
          {t.duplicate}
        </button>
        <button
          type="button"
          className="btn-ghost px-0 py-1.5 text-[11px]"
          disabled={!selected.length}
          onClick={() => editor.deleteSelection()}
        >
          {t.remove}
        </button>
      </section>

      {/* Inspector ----------------------------------------------------- */}
      <section>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <p className="label mb-0">{t.inspector}</p>
          {selected.length > 1 && (
            <span className="text-[11px] text-[color:var(--ink-dim)]">{t.selected(selected.length)}</span>
          )}
        </div>

        {finishPicked ? (
          <NumberRow
            label={t.trackLength}
            value={editor.finishY}
            min={FINISH_MIN}
            max={FINISH_MAX}
            step={20}
            display={String(Math.round(editor.finishY))}
            onChange={(value) => editor.setFinishY(value)}
          />
        ) : !selected.length ? (
          <p className="text-[11px] leading-relaxed text-[color:var(--ink-dim)]">{t.nothing}</p>
        ) : !kind ? (
          <p className="text-[11px] text-[color:var(--ink-dim)]">{t.mixed}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-[12px] font-semibold">{t.tools[kind]}</p>
            {kind === 'decal' && selected.length === 1 && (
              <p className="truncate text-[11px] text-[color:var(--ink-dim)]" title={(first as DecalItem).art.label}>
                {(first as DecalItem).art.label}
              </p>
            )}

            {(FLAGS[kind] ?? []).map((flag) => (
              <label key={flag} className="flex cursor-pointer items-center justify-between gap-3 text-[12px]">
                <span>{t.flags[flag as 'bumper' | 'hot']}</span>
                <input
                  type="checkbox"
                  className="accent-[color:var(--cool)]"
                  checked={(first as unknown as Record<string, boolean>)[flag] === true}
                  onChange={() => editor.toggleFlag(flag as 'bumper' | 'hot')}
                />
              </label>
            ))}

            {FIELDS[kind].map((spec) => (
              <NumberRow
                key={spec.key}
                label={t.fields[spec.key as keyof typeof t.fields]}
                value={readField(spec)}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                display={format(spec, readField(spec))}
                onChange={(value) => editor.setFieldOn(spec.key, value)}
              />
            ))}

            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={() => editor.reorder(true)}>
                {t.front}
              </button>
              <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={() => editor.reorder(false)}>
                {t.back}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Board ---------------------------------------------------------- */}
      <section className="flex flex-col gap-2.5 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="accent-[color:var(--cool)]"
              checked={editor.showGrid}
              onChange={(event) => editor.setShowGrid(event.target.checked)}
            />
            {t.grid}
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="accent-[color:var(--cool)]"
              checked={editor.snapEnabled}
              onChange={(event) => editor.setSnap(event.target.checked)}
            />
            {t.snap}
          </label>
          <div className="segment ml-auto">
            {[5, 10, 20].map((size) => (
              <button
                key={size}
                type="button"
                data-active={editor.grid === size}
                title={t.gridSize}
                onClick={() => editor.setGrid(size)}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" title={t.zoomOut} onClick={() => onZoom(1 / 1.3)}>
            &minus;
          </button>
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" title={t.zoomIn} onClick={() => onZoom(1.3)}>
            +
          </button>
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={() => onLookAt(0)}>
            {t.toStart}
          </button>
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={() => onLookAt(editor.finishY)}>
            {t.toFinish}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={() => editor.selectAll()}>
            {t.selectAll}
          </button>
          <button
            type="button"
            className="btn-ghost px-0 py-1.5 text-[11px]"
            disabled={!editor.itemCount}
            onClick={() => editor.clearItems()}
          >
            {t.clear}
          </button>
        </div>

        <p className="text-[10px] leading-relaxed text-[color:var(--ink-dim)]">
          {ITEM_KINDS.filter((item) => counts[item] > 0)
            .map((item) => `${t.tools[item]} ${counts[item]}`)
            .join(' · ')}
        </p>
      </section>

      {/* Files and hand off --------------------------------------------- */}
      <section className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
        <div className="grid grid-cols-2 gap-1.5">
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={onRandom}>
            <DiceIcon size={12} />
            {t.random}
          </button>
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={onRegenerate}>
            {t.regenerate}
          </button>
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={exportMap}>
            {t.export}
          </button>
          <button type="button" className="btn-ghost px-0 py-1.5 text-[11px]" onClick={() => fileRef.current?.click()}>
            {t.import}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            void importMap(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        {note && (
          <p className="text-[11px]" style={{ color: '#ff8f6a' }}>
            {note}
          </p>
        )}

        <button type="button" className="btn-ghost w-full py-1.5 text-[11px]" onClick={onExit}>
          {t.revert}
        </button>
      </section>
    </div>
  );
}

interface NumberRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}

/** Label, live readout and a slider, which is what a drag-first editor wants. */
function NumberRow({ label, value, min, max, step, display, onChange }: NumberRowProps) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[11px]">
        <span className="text-[color:var(--ink-dim)]">{label}</span>
        <span className="font-mono text-[11px]">{display}</span>
      </span>
      <input
        type="range"
        className="range-field mt-1"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
