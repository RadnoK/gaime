/** Tiny synthesised sounds for server events — no audio files needed. */
const TONES: Record<string, Array<[number, number]>> = {
  wave: [[330, 0.12], [440, 0.12], [660, 0.2]],
  cleared: [[660, 0.1], [880, 0.18]],
  down: [[220, 0.25], [150, 0.3]],
  lost: [[300, 0.3], [200, 0.3], [120, 0.5]],
};

export class Sounds {
  private context?: AudioContext;
  muted = localStorage.getItem('gaime:muted') === '1';

  play(kind: string) {
    const tones = TONES[kind];
    if (!tones || this.muted) return;
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') void this.context.resume();
    let at = this.context.currentTime;
    for (const [frequency, length] of tones) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.08, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      oscillator.connect(gain).connect(this.context.destination);
      oscillator.start(at);
      oscillator.stop(at + length);
      at += length * 0.8;
    }
  }

  toggle() {
    this.muted = !this.muted;
    localStorage.setItem('gaime:muted', this.muted ? '1' : '0');
    return this.muted;
  }

  dispose() { void this.context?.close(); }
}
