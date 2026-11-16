// Gloamguard — synthesized sound, WebAudio only, no audio files.
// All sounds are built from oscillators + filtered noise at call time.
// AudioContext is created lazily on the first user gesture; every method
// is a no-op (guarded) until then, so headless screenshots never break.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.musicTimer = null;
    this.musicStep = 0;
  }

  // Call from a user gesture (click / keydown).
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch { /* audio unavailable — game stays silent */ }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.35;
    return this.muted;
  }

  _tone({ freq = 440, freq2 = null, dur = 0.15, type = 'sine', vol = 0.5, delay = 0 }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freq2 !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  _noise({ dur = 0.2, vol = 0.4, freq = 1200, q = 1, delay = 0, type = 'bandpass' }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0);
  }

  bolt() { this._tone({ freq: 880, freq2: 220, dur: 0.12, type: 'sawtooth', vol: 0.22 }); this._noise({ dur: 0.08, vol: 0.15, freq: 3200 }); }
  hit() { this._tone({ freq: 180, freq2: 70, dur: 0.1, type: 'square', vol: 0.3 }); this._noise({ dur: 0.06, vol: 0.2, freq: 900 }); }
  kill() { this._tone({ freq: 520, freq2: 1040, dur: 0.18, type: 'triangle', vol: 0.35 }); this._tone({ freq: 780, freq2: 1560, dur: 0.22, type: 'triangle', vol: 0.22, delay: 0.06 }); }
  dash() { this._noise({ dur: 0.22, vol: 0.3, freq: 900, q: 0.6 }); }
  warn() { this._tone({ freq: 220, freq2: 220, dur: 0.16, type: 'square', vol: 0.25 }); this._tone({ freq: 220, freq2: 220, dur: 0.16, type: 'square', vol: 0.25, delay: 0.22 }); }
  pickup() { this._tone({ freq: 660, dur: 0.09, type: 'sine', vol: 0.3 }); this._tone({ freq: 990, dur: 0.14, type: 'sine', vol: 0.3, delay: 0.07 }); }
  hurt() { this._tone({ freq: 140, freq2: 60, dur: 0.25, type: 'sawtooth', vol: 0.4 }); }
  horn() { this._tone({ freq: 196, dur: 0.7, type: 'sawtooth', vol: 0.28 }); this._tone({ freq: 294, dur: 0.7, type: 'sawtooth', vol: 0.22, delay: 0.05 }); this._tone({ freq: 392, dur: 0.5, type: 'triangle', vol: 0.2, delay: 0.1 }); }
  waveClear() { [523, 659, 784, 1046].forEach((f, i) => this._tone({ freq: f, dur: 0.22, type: 'triangle', vol: 0.3, delay: i * 0.09 })); }
  defeat() { [330, 262, 196, 131].forEach((f, i) => this._tone({ freq: f, dur: 0.5, type: 'sawtooth', vol: 0.22, delay: i * 0.22 })); }
  // Three short boss motifs: low brass hit, dissonant sting, rising alarm.
  bossMotif(i) {
    if (i === 0) { this._tone({ freq: 98, dur: 0.5, type: 'sawtooth', vol: 0.4 }); this._tone({ freq: 147, dur: 0.5, type: 'sawtooth', vol: 0.3, delay: 0.08 }); }
    else if (i === 1) { this._tone({ freq: 220, dur: 0.3, type: 'square', vol: 0.25 }); this._tone({ freq: 233, dur: 0.3, type: 'square', vol: 0.25, delay: 0.02 }); this._noise({ dur: 0.3, vol: 0.25, freq: 500 }); }
    else { [110, 165, 220, 330].forEach((f, j) => this._tone({ freq: f, dur: 0.16, type: 'sawtooth', vol: 0.3, delay: j * 0.1 })); }
  }
  slam() { this._tone({ freq: 90, freq2: 35, dur: 0.5, type: 'sine', vol: 0.7 }); this._noise({ dur: 0.35, vol: 0.4, freq: 300, type: 'lowpass' }); }

  // Light percussive loop: low drum pulse + soft tick, scheduled in 8th notes.
  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    const stepDur = 0.21; // ~142 bpm 8th notes
    this.musicTimer = setInterval(() => {
      if (this.muted || !this.ctx) return;
      const s = this.musicStep++ % 16;
      if (s % 4 === 0) this._tone({ freq: 70, freq2: 40, dur: 0.18, type: 'sine', vol: 0.5 });
      if (s % 4 === 2) this._noise({ dur: 0.05, vol: 0.1, freq: 6000, type: 'highpass' });
      if (s === 0 || s === 10) this._tone({ freq: 196, dur: 0.3, type: 'triangle', vol: 0.12 });
      if (s === 6) this._tone({ freq: 147, dur: 0.3, type: 'triangle', vol: 0.12 });
    }, stepDur * 1000);
  }
  stopMusic() { if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; } }
}
