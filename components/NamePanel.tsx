'use client';

import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { MAX_NAMES } from '../lib/course';
import type { Messages } from '../lib/i18n';
import { css, marbleColor } from '../lib/palette';
import { SKIN_ACCEPT, readSkinFile, type Skin } from '../lib/skins';

interface NamePanelProps {
  names: string[];
  messages: Messages;
  disabled: boolean;
  skins: Record<string, Skin>;
  onAdd: (raw: string) => void;
  onRemove: (index: number) => void;
  onSkin: (name: string, skin: Skin | null) => void;
  onSkinError: (message: string) => void;
  title: string;
  children?: ReactNode;
}

export default function NamePanel({
  names,
  messages,
  disabled,
  skins,
  onAdd,
  onRemove,
  onSkin,
  onSkinError,
  title,
  children,
}: NamePanelProps) {
  const t = messages.roster;
  const text = messages.skin;
  const fileRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<string | null>(null);

  const pickSkin = (name: string) => {
    targetRef.current = name;
    fileRef.current?.click();
  };

  const readSkin = async (file: File | undefined) => {
    const name = targetRef.current;
    if (!file || !name) return;
    const result = await readSkinFile(file);
    if ('error' in result) {
      onSkinError(
        result.error === 'size'
          ? text.tooBig
          : result.error === 'unpack'
            ? text.unpack
            : text.badType,
      );
      return;
    }
    onSkin(name, result.skin);
  };
  const [draft, setDraft] = useState('');
  const full = names.length >= MAX_NAMES;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && draft === '' && names.length > 0) {
      onRemove(names.length - 1);
    }
  };

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <span className="text-[11px] text-[color:var(--ink-dim)]">{t.counter(names.length, MAX_NAMES)}</span>
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <input
          className="field"
          value={draft}
          disabled={disabled || full}
          placeholder={full ? t.full : t.placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={t.addLabel}
        />
        <button type="submit" className="btn-ghost shrink-0" disabled={disabled || full || !draft.trim()}>
          {t.add}
        </button>
      </form>


      <div className={`scroll-thin flex max-h-[210px] flex-wrap gap-2 overflow-y-auto pr-1 ${names.length ? 'mt-3' : ''}`}>
        {names.map((name, index) => {
          const skin = skins[name];
          return (
            <span key={`${name}-${index}`} className="chip">
              <button
                type="button"
                className="grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-full transition hover:ring-2 hover:ring-white/25 disabled:cursor-not-allowed"
                style={{ backgroundColor: css(marbleColor(index)) }}
                onClick={() => pickSkin(name)}
                disabled={disabled}
                title={text.add(name)}
                aria-label={text.add(name)}
              >
                {skin && (skin.kind !== 'lottie' || skin.thumb) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={skin.thumb ?? skin.uri} alt="" className="h-full w-full object-cover" />
                )}
                {skin && skin.kind === 'lottie' && !skin.thumb && (
                  <span className="text-[8px] font-black text-black">L</span>
                )}
              </button>

              <span className="max-w-[150px] truncate">{name}</span>

              {skin && (
                <button
                  type="button"
                  className="grid h-6 w-6 place-items-center rounded-full text-[color:var(--ink-dim)] transition hover:bg-white/10 hover:text-white sm:h-5 sm:w-5"
                  onClick={() => onSkin(name, null)}
                  disabled={disabled}
                  title={text.clear(name)}
                  aria-label={text.clear(name)}
                >
                  ⟲
                </button>
              )}

              <button
                type="button"
                className="grid h-6 w-6 place-items-center rounded-full sm:h-5 sm:w-5 text-[color:var(--ink-dim)] transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                onClick={() => onRemove(index)}
                disabled={disabled}
                aria-label={t.remove(name)}
              >
                &times;
              </button>
            </span>
          );
        })}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={SKIN_ACCEPT}
        className="hidden"
        onChange={(event) => {
          void readSkin(event.target.files?.[0]);
          event.target.value = '';
        }}
      />

      {children}
    </div>
  );
}
