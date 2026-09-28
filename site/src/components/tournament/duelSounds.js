// Sound effects for the pixel duel, synthesised with Web Audio (no sound files to load).
// Gunshots and ricochets are the loudest; everything else is kept quiet. Browsers only allow
// audio after the page has been clicked or a key pressed, so the context is resumed on the
// first interaction.

const MASTER = 0.35;

let ctx = null;
let master = null;
let noise = null;
let enabled = false;

function audio() {
  if (ctx) return ctx;
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = MASTER;
  // a limiter, so the loud sounds overlapping never distort
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  master.connect(limiter).connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
  const unlock = () => {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return ctx;
}

export function setSoundEnabled(on) {
  enabled = Boolean(on);
  const c = enabled ? audio() : ctx;
  if (c && enabled && c.state === "suspended") c.resume().catch(() => {});
}

// A gain envelope: quick attack, exponential decay to silence.
function env(t, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(master);
  return g;
}

function noiseBurst(t, { peak, attack = 0.002, decay, type = "bandpass", freq, q = 1, sweepTo = null }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
  f.Q.value = q;
  src.connect(f).connect(env(t, peak, attack, decay));
  src.start(t, Math.random() * 0.5);
  src.stop(t + attack + decay + 0.05);
}

function tone(t, { peak, attack = 0.003, decay, type = "sine", from, to = from }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  o.connect(env(t, peak, attack, decay));
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

const SOUNDS = {
  pistol(t) {
    noiseBurst(t, { peak: 0.9, decay: 0.16, freq: 1800, q: 0.7, sweepTo: 500 });
    tone(t, { peak: 0.7, decay: 0.12, type: "triangle", from: 180, to: 50 });
  },
  sniper(t) {
    noiseBurst(t, { peak: 2, decay: 0.1, type: "highpass", freq: 2500, q: 0.5 });
    noiseBurst(t, { peak: 1.8, decay: 0.6, freq: 900, q: 0.6, sweepTo: 180 });
    tone(t, { peak: 2, decay: 0.4, type: "triangle", from: 120, to: 35 });
  },
  // COUNTER: the agent shooting their own shield, louder than a normal pistol shot
  counterShot(t) {
    noiseBurst(t, { peak: 1.8, decay: 0.2, freq: 1800, q: 0.7, sweepTo: 500 });
    tone(t, { peak: 1.4, decay: 0.15, type: "triangle", from: 180, to: 50 });
  },
  // a bullet glancing off the shield: a falling whine with a metallic tick
  ricochet(t) {
    noiseBurst(t, { peak: 0.35, decay: 0.03, type: "highpass", freq: 4000 });
    tone(t, { peak: 0.28, attack: 0.005, decay: 0.35, type: "sawtooth", from: 3200 + Math.random() * 600, to: 900 });
    tone(t, { peak: 0.2, decay: 0.25, from: 2400, to: 2300 });
  },
  // the red COUNTER shield throwing a bullet back
  reflect(t) {
    tone(t, { peak: 0.9, decay: 0.4, type: "square", from: 700, to: 2600 });
    noiseBurst(t, { peak: 0.8, decay: 0.06, type: "highpass", freq: 3500 });
  },
  clash(t) {
    noiseBurst(t, { peak: 0.5, decay: 0.2, type: "highpass", freq: 3000 });
    tone(t, { peak: 0.25, decay: 0.5, from: 1900, to: 1850 });
    tone(t, { peak: 0.2, decay: 0.45, from: 2700, to: 2650 });
  },
  hit(t) {
    tone(t, { peak: 0.25, decay: 0.12, type: "triangle", from: 140, to: 60 });
    noiseBurst(t, { peak: 0.15, decay: 0.08, type: "lowpass", freq: 800 });
  },
  // quiet ones
  reload(t) {
    noiseBurst(t, { peak: 0.12, decay: 0.03, freq: 2500, q: 3 });
    noiseBurst(t + 0.12, { peak: 0.16, decay: 0.04, freq: 1600, q: 3 });
  },
  shield(t) {
    tone(t, { peak: 0.06, attack: 0.08, decay: 0.3, from: 300, to: 900 });
    noiseBurst(t, { peak: 0.05, attack: 0.08, decay: 0.25, freq: 1200, q: 1.5, sweepTo: 3000 });
  },
  // the COUNTER shot striking the shield and turning it red
  shieldHit(t) {
    tone(t, { peak: 0.8, decay: 0.45, from: 1500, to: 1400 });
    tone(t, { peak: 0.5, decay: 0.35, type: "square", from: 420, to: 900 });
    noiseBurst(t, { peak: 0.5, decay: 0.05, type: "highpass", freq: 3000 });
  },
  casing(t) {
    tone(t, { peak: 0.04, decay: 0.06, from: 4200 + Math.random() * 800 });
  },
  fall(t) {
    tone(t, { peak: 0.2, decay: 0.25, type: "triangle", from: 90, to: 40 });
    noiseBurst(t, { peak: 0.1, decay: 0.2, type: "lowpass", freq: 500 });
  },
};

export function playSound(name, delayMs = 0) {
  if (!enabled || !ctx || ctx.state !== "running" || !SOUNDS[name]) return;
  try {
    SOUNDS[name](ctx.currentTime + delayMs / 1000);
  } catch {
    // never let a sound break the animation
  }
}
