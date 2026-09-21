/**
 * Sound effects, synthesised on the spot with Web Audio: no samples to fetch,
 * and every hit can be voiced from how hard it actually landed.
 *
 * A browser only lets audio start from a user gesture, so the context is built
 * by `unlock()`, which the stage calls from the click that drops the marbles.
 * Until then, and whenever sound is switched off, every call here is a no-op.
 */

/** Hits closer together than this blur into a buzz, so the extras are dropped. */
const TICK_GAP = 0.028;
const BUMP_GAP = 0.06;
const BOOST_GAP = 0.12;

interface ToneOptions {
  type: OscillatorType;
  from: number;
  /** Frequency the tone glides to over its length. */
  to?: number;
  gain: number;
  length: number;
  attack?: number;
  /** Seconds from now. */
  at?: number;
  pan?: number;
}

export class Sound {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #noise: AudioBuffer | null = null;
  #enabled = true;
  #lastTick = 0;
  #lastBump = 0;
  #lastBoost = 0;

  /** Builds or wakes the audio context. Must run inside a user gesture. */
  unlock(): void {
    if (!this.#enabled) return;

    if (!this.#ctx) {
      const Context =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;

      try {
        const ctx = new Context();
        const master = ctx.createGain();
        master.gain.value = 0.5;

        // A gentle limiter: a pile up of twenty marbles must not clip.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -14;
        limiter.knee.value = 12;
        limiter.ratio.value = 8;
        master.connect(limiter).connect(ctx.destination);

        const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

        this.#ctx = ctx;
        this.#master = master;
        this.#noise = noise;
      } catch (err) {
        console.warn('[thorvg-pinrace] audio could not start:', err);
        return;
      }
    }

    if (this.#ctx.state === 'suspended') void this.#ctx.resume().catch(() => undefined);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (enabled) this.unlock();
    else void this.#ctx?.suspend().catch(() => undefined);
  }

  dispose(): void {
    void this.#ctx?.close().catch(() => undefined);
    this.#ctx = null;
    this.#master = null;
    this.#noise = null;
  }

  /**
   * A marble landing on something.
   *
   * @param strength 0..1, how hard it hit
   * @param bumper   true for bumpers and hot machinery, which ring rather than tick
   * @param pan      -1..1 across the board
   */
  impact(strength: number, bumper: boolean, pan: number): void {
    const ctx = this.#live();
    if (!ctx) return;
    const now = ctx.currentTime;

    if (bumper) {
      if (now - this.#lastBump < BUMP_GAP) return;
      this.#lastBump = now;

      const pitch = 300 + Math.random() * 90;
      const gain = 0.16 + strength * 0.3;
      this.#tone({ type: 'sine', from: pitch * 1.9, to: pitch, gain, length: 0.2, pan });
      this.#tone({ type: 'triangle', from: pitch * 3.02, to: pitch * 2.4, gain: gain * 0.32, length: 0.11, pan });
      return;
    }

    if (now - this.#lastTick < TICK_GAP) return;
    this.#lastTick = now;

    const pitch = 1050 + Math.random() * 650 + strength * 380;
    this.#tone({ type: 'triangle', from: pitch, to: pitch * 0.72, gain: 0.05 + strength * 0.2, length: 0.055, pan });
    this.#hiss({ from: 3200, to: 2400, q: 1.2, gain: 0.03 + strength * 0.08, length: 0.03, pan });
  }

  /** A marble picking up a boost pad. */
  boost(pan: number): void {
    const ctx = this.#live();
    if (!ctx) return;
    if (ctx.currentTime - this.#lastBoost < BOOST_GAP) return;
    this.#lastBoost = ctx.currentTime;

    this.#hiss({ from: 500, to: 3600, q: 2.4, gain: 0.2, length: 0.36, attack: 0.05, pan });
    this.#tone({ type: 'sawtooth', from: 190, to: 760, gain: 0.07, length: 0.32, attack: 0.04, pan });
  }

  /** One beat of the countdown. */
  count(): void {
    this.#tone({ type: 'square', from: 440, gain: 0.1, length: 0.13 });
    this.#tone({ type: 'sine', from: 880, gain: 0.08, length: 0.16 });
  }

  go(): void {
    this.#tone({ type: 'square', from: 880, gain: 0.11, length: 0.42 });
    this.#tone({ type: 'sine', from: 1760, gain: 0.08, length: 0.5 });
    this.#hiss({ from: 900, to: 5200, q: 0.8, gain: 0.12, length: 0.3, attack: 0.02 });
  }

  leadChange(): void {
    this.#tone({ type: 'triangle', from: 659.25, gain: 0.13, length: 0.12 });
    this.#tone({ type: 'triangle', from: 987.77, gain: 0.13, length: 0.2, at: 0.09 });
  }

  finalStretch(): void {
    [392, 493.88, 587.33, 783.99].forEach((note, i) =>
      this.#tone({ type: 'sawtooth', from: note, gain: 0.07, length: 0.16, at: i * 0.075 }),
    );
  }

  /** A runner other than the winner crossing the line. */
  placed(): void {
    this.#tone({ type: 'sine', from: 1318.5, gain: 0.12, length: 0.34 });
    this.#tone({ type: 'sine', from: 1975.5, gain: 0.05, length: 0.28, at: 0.02 });
  }

  /** The winner's fanfare. */
  finish(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((note, i) => {
      const last = i === notes.length - 1;
      this.#tone({ type: 'triangle', from: note, gain: 0.17, length: last ? 0.95 : 0.26, at: i * 0.13 });
      this.#tone({ type: 'square', from: note * 2, gain: 0.025, length: last ? 0.7 : 0.18, at: i * 0.13 });
    });
    // The chord rings on underneath once the run up lands.
    for (const note of [261.63, 392, 523.25]) {
      this.#tone({ type: 'sine', from: note, gain: 0.08, length: 1.3, attack: 0.04, at: 0.39 });
    }
    this.#hiss({ from: 5200, to: 8200, q: 0.7, gain: 0.07, length: 0.9, attack: 0.03, at: 0.39 });
  }

  /** The context, when there is one and it is allowed to make noise. */
  #live(): AudioContext | null {
    if (!this.#enabled || !this.#ctx || this.#ctx.state !== 'running') return null;
    return this.#ctx;
  }

  #out(ctx: AudioContext, pan: number | undefined): AudioNode {
    const master = this.#master as GainNode;
    if (!pan || typeof ctx.createStereoPanner !== 'function') return master;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(master);
    return panner;
  }

  #envelope(ctx: AudioContext, start: number, gain: number, length: number, attack: number): GainNode {
    const node = ctx.createGain();
    node.gain.setValueAtTime(0.0001, start);
    node.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, start + length);
    return node;
  }

  #tone(options: ToneOptions): void {
    const ctx = this.#live();
    if (!ctx) return;

    const start = ctx.currentTime + (options.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = options.type;
    osc.frequency.setValueAtTime(options.from, start);
    if (options.to) osc.frequency.exponentialRampToValueAtTime(options.to, start + options.length);

    const envelope = this.#envelope(ctx, start, options.gain, options.length, options.attack ?? 0.004);
    osc.connect(envelope).connect(this.#out(ctx, options.pan));
    osc.start(start);
    osc.stop(start + options.length + 0.02);
  }

  /** A burst of noise through a band pass that sweeps from one pitch to another. */
  #hiss(options: {
    from: number;
    to: number;
    q: number;
    gain: number;
    length: number;
    attack?: number;
    at?: number;
    pan?: number;
  }): void {
    const ctx = this.#live();
    if (!ctx || !this.#noise) return;

    const start = ctx.currentTime + (options.at ?? 0);
    const source = ctx.createBufferSource();
    source.buffer = this.#noise;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = options.q;
    filter.frequency.setValueAtTime(options.from, start);
    filter.frequency.exponentialRampToValueAtTime(options.to, start + options.length);

    const envelope = this.#envelope(ctx, start, options.gain, options.length, options.attack ?? 0.003);
    source.connect(filter).connect(envelope).connect(this.#out(ctx, options.pan));
    // Started at a random offset so two bursts never sound like the same one.
    source.start(start, Math.random() * 0.4);
    source.stop(start + options.length + 0.02);
  }
}
