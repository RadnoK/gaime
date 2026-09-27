/**
 * Game audio without boilerplate: synthesised effects (no files needed) and audio
 * files from `public/`, one mute switch remembered per browser, and a music loop.
 *
 *   const sounds = new SoundBank({
 *     sounds: { coin: tones([[880, 0.08], [1320, 0.12]]), boom: { url: '/audio/boom.mp3', volume: 0.6 } },
 *     music: { url: '/audio/theme.mp3', volume: 0.2 },
 *   });
 *   net.on('event', (name, data) => { if (name === 'sound') sounds.play((data as { kind: string }).kind); });
 *
 * Browsers only allow audio after a user gesture; the bank unlocks itself on the first click/key.
 */
export interface ToneSound {
  tones: Array<[frequency: number, seconds: number]>;
  wave?: OscillatorType;
  volume?: number;
}

export interface FileSound {
  url: string;
  volume?: number;
}

export type SoundDefinition = ToneSound | FileSound;

export function tones(list: Array<[number, number]>, wave: OscillatorType = 'triangle', volume = 0.08): ToneSound {
  return { tones: list, wave, volume };
}

export interface SoundBankOptions {
  sounds: Record<string, SoundDefinition>;
  music?: FileSound;
  /** Master volume 0..1. Default 1. */
  volume?: number;
  /** localStorage key for the mute switch. Default 'gaime:muted'. */
  storageKey?: string;
}

export class SoundBank {
  private context?: AudioContext;
  private master?: GainNode;
  private readonly buffers = new Map<string, Promise<AudioBuffer | undefined>>();
  private musicSource?: AudioBufferSourceNode;
  private musicWanted = false;
  private readonly abort = new AbortController();
  muted: boolean;

  constructor(private readonly options: SoundBankOptions) {
    this.muted = localStorage.getItem(options.storageKey ?? 'gaime:muted') === '1';
    const unlock = () => { this.ensure(); if (this.musicWanted) void this.startMusic(); };
    for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, unlock, { once: true, signal: this.abort.signal });
  }

  private ensure() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : this.options.volume ?? 1;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  private buffer(url: string) {
    let pending = this.buffers.get(url);
    if (!pending) {
      const context = this.ensure();
      pending = fetch(url).then(response => response.arrayBuffer()).then(data => context.decodeAudioData(data)).catch(error => { console.warn(`[gaime] sound ${url}`, error); return undefined; });
      this.buffers.set(url, pending);
    }
    return pending;
  }

  /** Decode file sounds up front (optional; otherwise the first play loads them). */
  preload() {
    for (const sound of Object.values(this.options.sounds)) if ('url' in sound) void this.buffer(sound.url);
  }

  play(name: string, options: { volume?: number; rate?: number } = {}) {
    const sound = this.options.sounds[name];
    if (!sound) { console.warn(`[gaime] unknown sound "${name}"`); return; }
    if (this.muted) return;
    const context = this.ensure();
    const gain = context.createGain();
    gain.connect(this.master!);
    if ('url' in sound) {
      gain.gain.value = (sound.volume ?? 1) * (options.volume ?? 1);
      void this.buffer(sound.url).then(buffer => {
        if (!buffer) return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = options.rate ?? 1;
        source.connect(gain);
        source.start();
      });
      return;
    }
    let at = context.currentTime;
    for (const [frequency, length] of sound.tones) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = sound.wave ?? 'triangle';
      oscillator.frequency.value = frequency * (options.rate ?? 1);
      envelope.gain.setValueAtTime((sound.volume ?? 0.08) * (options.volume ?? 1), at);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
      oscillator.connect(envelope).connect(gain);
      oscillator.start(at);
      oscillator.stop(at + length);
      at += length * 0.8;
    }
  }

  /** Start the music loop (waits for the first user gesture if needed). */
  music(play = true) {
    this.musicWanted = play;
    if (play) void this.startMusic(); else { this.musicSource?.stop(); this.musicSource = undefined; }
  }

  private async startMusic() {
    const music = this.options.music;
    if (!music || this.musicSource || !this.context) return;
    const buffer = await this.buffer(music.url);
    if (!buffer || !this.musicWanted || this.musicSource) return;
    const gain = this.context.createGain();
    gain.gain.value = music.volume ?? 0.3;
    gain.connect(this.master!);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();
    this.musicSource = source;
  }

  /** Toggle mute (remembered); returns the new state. */
  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem(this.options.storageKey ?? 'gaime:muted', this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : this.options.volume ?? 1;
    return this.muted;
  }

  setVolume(volume: number) {
    this.options.volume = Math.max(0, Math.min(1, volume));
    if (this.master && !this.muted) this.master.gain.value = this.options.volume;
  }

  dispose() {
    this.abort.abort();
    this.musicSource?.stop();
    void this.context?.close();
  }
}
