/** Message catalogue shape. `en` is the source of truth, every locale must match it. */

export const LOCALES = ['en', 'ko'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Locales whose UI strings need the CJK face loaded into ThorVG. */
export const CJK_LOCALES: readonly Locale[] = ['ko'];

export interface Messages {
  /** Native name shown in the language switch. */
  name: string;
  /** Two letter form, used when the header has no room. */
  code: string;

  status: {
    empty: string;
    ready: string;
    preview: string;
    countdown: string;
    racing: string;
    reveal: string;
  };

  run: {
    runners: (count: number) => string;
    drop: string;
    running: string;
    again: string;
    reset: string;
    newSeed: string;
    needTwo: string;
  };

  roster: {
    title: string;
    counter: (count: number, max: number) => string;
    placeholder: string;
    full: string;
    add: string;
    hint: string;
    empty: string;
    demo: string;
    clear: string;
    remove: (name: string) => string;
    addLabel: string;
  };

  winner: {
    label: string;
    /** Heading over the finishing order. */
    ranking: string;
    dnf: string;
    result: (seconds: string, seed: string) => string;
    photoPrefix: string;
    again: string;
    drop: string;
  };

  settings: {
    title: string;
    seed: string;
    copy: string;
    copied: string;
    track: string;
    speed: string;
    tracks: Record<'short' | 'standard' | 'epic', { label: string; hint: string }>;
    speeds: Record<'slow' | 'normal' | 'fast', string>;
    mode: string;
    modeWinner: string;
    modeRanking: string;
    view: string;
    viewBoard: string;
    viewRide: string;
    follow: string;
    followLeader: string;
    record: string;
    sound: string;
    recordUnsupported: string;
    /** Bakes the run into a vector animation. */
    lottie: string;
    lottieBaking: string;
    lottieTrails: string;
    lottieHint: string;
  };

  stage: {
    starting: string;
    failed: string;
    retry: string;
    enterFullscreen: string;
    exitFullscreen: string;
    rec: string;
    saving: string;
  };

  language: string;

  skin: {
    add: (name: string) => string;
    clear: (name: string) => string;
    tooBig: string;
    badType: string;
    /** A packed file that would not unpack into a Lottie. */
    unpack: string;
    /** The stored session had no room for the marble artwork. */
    dropped: string;
  };

  editor: {
    title: string;
    /** Header button that opens the editor. */
    open: string;
    /** Header button that saves the map and closes the editor. */
    save: string;
    revert: string;
    /** Badge shown on the run panel while a hand drawn map is in use. */
    custom: string;
    useGenerated: string;
    /** What a shared link can and cannot carry. */
    /** Puts a saved map up for the gallery. */
    shareGallery: string;
    gallery: string;
    linkNoArtwork: string;
    linkTooLarge: string;
    linkUnsupported: string;
    regenerate: string;
    /** Rolls a whole new track. */
    random: string;
    tools: Record<'select' | 'peg' | 'wall' | 'spinner' | 'pendulum' | 'slider' | 'booster' | 'decal', string>;
    toolsLabel: string;
    /** Drag and drop artwork onto the board. */
    dropHint: string;
    dropTooBig: string;
    dropBadType: string;
    dropFailed: string;
    dropUnpack: string;
    artwork: string;
    /** Inspector labels, keyed by blueprint field. */
    fields: Record<
      'r' | 'arms' | 'length' | 'thickness' | 'hub' | 'omega' | 'phase' | 'amp' | 'halfLength' | 'travel' | 'tilt' | 'w' | 'h' | 'force' | 'opacity',
      string
    >;
    flags: { bumper: string; hot: string };
    inspector: string;
    nothing: string;
    mixed: string;
    selected: (count: number) => string;
    pieces: (count: number) => string;
    undo: string;
    redo: string;
    duplicate: string;
    remove: string;
    clear: string;
    selectAll: string;
    front: string;
    back: string;
    grid: string;
    snap: string;
    gridSize: string;
    trackLength: string;
    zoomIn: string;
    zoomOut: string;
    toStart: string;
    toFinish: string;
    export: string;
    import: string;
    importFailed: string;
  };

  /** Strings ThorVG draws inside the canvas. */
  canvas: {
    ready: string;
    addRunners: string;
    preview: string;
    go: string;
    leadChange: string;
    leadChangeSub: (name: string) => string;
    finalStretch: string;
    finalStretchSub: string;
    photoFinish: string;
    finish: string;
    winner: string;
    /** Banner as each runner comes in during a ranking run. */
    placed: (place: number) => string;
    results: string;
  };
}
