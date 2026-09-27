import React, { useEffect, useRef } from "react";

/*
 * The marquee duel as a pixel-art scene: a rainy night dock, two agents trading fire.
 *
 * Everything is drawn in code on a 320x180 canvas that CSS scales up with crisp pixels.
 * The static backdrop is painted once; lights, rain, agents, their cast shadows and wet-floor
 * reflections, projectiles and particles are drawn every frame. What happens is driven purely by
 * the replay turn the deterministic playback clock is on, so every screen shows the same fight.
 */

const W = 320;
const H = 180;
const HORIZON = 112; // skyline meets the water
const GROUND = 131; // dock surface starts
const FEET = 170; // where the agents stand
const XS = [72, 248];
const DIRS = [1, -1]; // both face the middle

// Turn choreography (a turn lasts 750ms on screen).
const T_FIRE = 150;
const TRAVEL = { SHOOT: 230, SNIPE: 70 };
const REFLECT_BACK = 220;
// COUNTER: the shield goes up, the agent swings the pistol up and shoots their own shield, which
// jerks forward and turns red. It is red before any enemy shot can land (snipe at 220ms, pistol at 380ms).
// The arm is shown in the aiming (pistol) pose from COUNTER_RAISE to COUNTER_LOWER; the angle is
// how far it hangs below fully aimed (0 = pointing straight ahead at the shield).
const COUNTER_RAISE = 30;
const COUNTER_LOWER = 330;
const COUNTER_AIM = [{ t: COUNTER_RAISE, v: 1.3 }, { t: 100, v: 0 }, { t: 230, v: 0 }, { t: COUNTER_LOWER, v: 1.3 }];
const COUNTER_FIRE = 110;
const COUNTER_HIT = 125;
const HURT_MS = 300;
const FALL_MS = 360;

// Sprite canvas: agents (with their weapons) are drawn around the feet at (OX, OY).
const SW = 150;
const SH = 100;
const OX = 72;
const OY = 94;

const GUN = "#15171d";
const GUN_LIGHT = "#4b515e";
const BRASS = "#c9a24a";

// --- small helpers ---------------------------------------------------------------------

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  const A = hexRgb(a);
  const B = hexRgb(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`;
}

function rect(g, x, y, w, h, c) {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

function line(g, x0, y0, x1, y1, color, size = 1) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  g.fillStyle = color;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < 2000; i++) {
    g.fillRect(x0, y0, size, size);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (t) => 1 - (1 - t) * (1 - t);

// 3x5 pixel font
const GLYPHS = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
  E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
  I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
  Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111",
  0: "111101101101111", 1: "010110010010111", 2: "110001010100111", 3: "110001010001110",
  4: "101101111001001", 5: "111100110001110", 6: "011100111101111", 7: "111001010010010",
  8: "111101111101111", 9: "111101111001110",
  "-": "000000111000000", "+": "000010111010000", ".": "000000000000010",
  "!": "010010010000010", "?": "110001010000010", " ": "000000000000000",
};

function cleanText(text, max = 16) {
  return String(text || "").toUpperCase().replace(/_/g, " ").replace(/[^A-Z0-9 .!?+-]/g, "").slice(0, max);
}

function drawText(g, text, x, y, color, scale = 1, alpha = 1) {
  const chars = [...cleanText(text, 40)];
  const width = chars.length * 4 * scale - scale;
  const left = Math.round(x - width / 2);
  g.save();
  g.globalAlpha = alpha;
  for (const [dx, dy, c] of [[scale, scale, "rgba(0,0,0,0.75)"], [0, 0, color]]) {
    g.fillStyle = c;
    chars.forEach((ch, i) => {
      const bits = GLYPHS[ch] || GLYPHS[" "];
      for (let b = 0; b < 15; b++) {
        if (bits[b] === "1") {
          g.fillRect(left + i * 4 * scale + (b % 3) * scale + dx, Math.round(y) + Math.floor(b / 3) * scale + dy, scale, scale);
        }
      }
    });
  }
  g.restore();
}

// --- the backdrop (painted once) ----------------------------------------------------------

function buildBackground() {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const r = rng(7);
  const antennas = [];

  // Night sky, lighter toward the hazy horizon
  for (let y = 0; y < HORIZON; y++) rect(g, 0, y, W, 1, mix("#0a0f19", "#2c3649", Math.pow(y / HORIZON, 1.4)));
  // Rain clouds, dithered
  for (let y = 0; y < 75; y++) {
    for (let x = 0; x < W; x++) {
      const n = Math.sin(x * 0.045 + y * 0.19) + Math.sin(x * 0.012 - y * 0.08) * 1.3 + r() * 0.7;
      if (n > 1.25 && (x + y) % 2 === 0) rect(g, x, y, 1, 1, "rgba(78,90,114,0.28)");
    }
  }

  // Far skyline in the haze
  for (let x = -4; x < W;) {
    const w = 8 + Math.floor(r() * 14);
    const h = 18 + Math.floor(r() * 42);
    rect(g, x, HORIZON - h, w, h, "#253045");
    for (let wy = HORIZON - h + 3; wy < HORIZON - 3; wy += 3) {
      for (let wx = x + 2; wx < x + w - 1; wx += 2) {
        if (r() < 0.14) rect(g, wx, wy, 1, 1, "rgba(214,212,172,0.45)");
      }
    }
    x += w + (r() < 0.3 ? 2 : 0);
  }
  // Near skyline: taller, darker, brighter windows
  const towers = [[36, 22, 50], [62, 16, 34], [96, 20, 60], [124, 12, 44], [150, 24, 70], [182, 14, 40],
    [206, 30, 92], [244, 18, 56], [268, 22, 78], [300, 20, 46]];
  for (const [x, w, h] of towers) {
    const top = HORIZON - h;
    rect(g, x, top, w, h, "#1a2131");
    rect(g, x + w - 1, top, 1, h, "#232c3e");
    if (h > 55) {
      rect(g, x + Math.floor(w / 2) - 3, top - 4, 6, 4, "#1a2131");
      rect(g, x + Math.floor(w / 2), top - 12, 1, 8, "#1a2131");
      antennas.push([x + Math.floor(w / 2), top - 13]);
    }
    for (let wy = top + 3; wy < HORIZON - 2; wy += 3) {
      for (let wx = x + 2; wx < x + w - 2; wx += 2) {
        if (r() < 0.22) rect(g, wx, wy, 1, 1, r() < 0.8 ? "rgba(236,230,186,0.85)" : "rgba(170,200,230,0.7)");
      }
    }
  }
  // Horizon haze
  const haze = g.createLinearGradient(0, HORIZON - 26, 0, HORIZON);
  haze.addColorStop(0, "rgba(95,110,138,0)");
  haze.addColorStop(1, "rgba(95,110,138,0.22)");
  g.fillStyle = haze;
  g.fillRect(0, HORIZON - 26, W, 26);

  // Harbour water with broken reflections of the city
  rect(g, 0, HORIZON, W, GROUND - HORIZON, "#111723");
  for (let i = 0; i < 140; i++) {
    const a = 0.08 + r() * 0.25;
    rect(g, Math.floor(r() * W), HORIZON + 1 + Math.floor(r() * (GROUND - HORIZON - 4)), 2 + Math.floor(r() * 4), 1, `rgba(205,205,172,${a})`);
  }

  // Ships
  for (let y = 114; y <= 123; y++) rect(g, 58 + (y - 114), y, 104 - (y - 114) * 2, 1, "#151b27");
  rect(g, 58, 114, 104, 1, "#2a3243");
  rect(g, 126, 103, 22, 11, "#18202e");
  rect(g, 130, 106, 2, 1, "rgba(236,230,186,0.8)");
  rect(g, 138, 106, 2, 1, "rgba(236,230,186,0.8)");
  rect(g, 100, 90, 1, 24, "#18202e");
  line(g, 100, 90, 126, 103, "#18202e");
  for (let y = 112; y <= 122; y++) rect(g, 176 + (y - 112), y, 138 - (y - 112) * 2, 1, "#141a26");
  rect(g, 176, 112, 138, 1, "#283042");
  const boxColors = ["#3a2b30", "#27364d", "#2c3d3d", "#453729", "#2f2a3f"];
  for (let row = 0; row < 3; row++) {
    for (let x = 206 - row * 2; x < 296 - row * 6; x += 11) {
      rect(g, x, 107 - row * 5, 10, 5, boxColors[Math.floor(r() * boxColors.length)]);
      rect(g, x, 107 - row * 5, 10, 1, "rgba(255,255,255,0.06)");
    }
  }
  rect(g, 180, 94, 16, 18, "#182030");
  rect(g, 183, 98, 3, 1, "rgba(236,230,186,0.8)");
  rect(g, 190, 88, 1, 6, "#182030");

  // Pier lamp posts
  const lamps = [44, 118, 176, 258];
  for (const lx of lamps) {
    rect(g, lx, 100, 1, 28, "#0f131b");
    rect(g, lx - 1, 99, 3, 1, "#2a303c");
    rect(g, lx, 100, 1, 1, "#ffe7b0");
  }

  // Dock edge and bollards
  rect(g, 0, 128, W, 3, "#39424f");
  rect(g, 0, 128, W, 1, "#5d6980");
  for (const bx of [22, 148, 204]) {
    rect(g, bx, 124, 4, 4, "#1d222c");
    rect(g, bx, 124, 4, 1, "#454e5f");
  }

  // Wet concrete
  for (let y = GROUND; y < H; y++) rect(g, 0, y, W, 1, mix("#232a3a", "#181d29", (y - GROUND) / (H - GROUND)));
  for (const sy of [142, 156, 172]) rect(g, 0, sy, W, 1, "#161b26");
  for (let y = GROUND; y < H; y += 14) {
    for (let x = (y / 14) % 2 ? 0 : 20; x < W; x += 40) rect(g, x, y, 1, 11, "#171c27");
  }
  for (let i = 0; i < 90; i++) {
    rect(g, Math.floor(r() * W), GROUND + 2 + Math.floor(r() * (H - GROUND - 2)), 3 + Math.floor(r() * 10), 1,
      `rgba(120,142,180,${0.08 + r() * 0.14})`);
  }
  for (let i = 0; i < 7; i++) {
    const px = 20 + r() * (W - 40);
    const py = GROUND + 8 + r() * (H - GROUND - 14);
    const pw = 18 + r() * 34;
    const ph = 2 + r() * 3;
    g.fillStyle = "rgba(70,88,122,0.30)";
    g.beginPath();
    g.ellipse(px, py, pw / 2, ph, 0, 0, Math.PI * 2);
    g.fill();
    rect(g, Math.round(px - pw / 5), Math.round(py - 1), Math.round(pw / 3), 1, "rgba(170,190,225,0.18)");
  }
  // Reflections of the lamps and the floodlight streak down the wet floor
  for (const lx of lamps) {
    for (let y = GROUND; y < H; y++) {
      const a = 0.22 * (1 - (y - GROUND) / (H - GROUND));
      rect(g, lx - 1 + (y % 3 === 0 ? 1 : 0), y, 2, 1, `rgba(255,214,160,${a})`);
    }
  }
  for (let y = GROUND; y < H; y++) {
    const a = 0.28 * (1 - (y - GROUND) / (H - GROUND));
    rect(g, 292 + (y % 4 === 0 ? 1 : 0), y, 4, 1, `rgba(215,228,255,${a})`);
  }
  // Brass casings and grit from earlier fights
  for (let i = 0; i < 14; i++) rect(g, Math.floor(r() * W), GROUND + 4 + Math.floor(r() * 44), 2, 1, i % 3 ? "#1c1a17" : "#6b5a33");

  // Backlit steel structure on the left
  const back = g.createLinearGradient(0, 0, 40, 0);
  back.addColorStop(0, "rgba(232,240,250,0.95)");
  back.addColorStop(0.45, "rgba(200,215,235,0.45)");
  back.addColorStop(1, "rgba(200,215,235,0)");
  g.fillStyle = back;
  g.fillRect(0, 0, 40, GROUND);
  const ground = g.createLinearGradient(0, 0, 60, 0);
  ground.addColorStop(0, "rgba(220,232,248,0.30)");
  ground.addColorStop(1, "rgba(220,232,248,0)");
  g.fillStyle = ground;
  g.fillRect(0, GROUND, 60, H - GROUND);
  for (const bx of [4, 24]) {
    rect(g, bx, 0, 4, GROUND, "#2b323f");
    rect(g, bx + 3, 0, 1, GROUND, "#566074");
  }
  for (let y = 0; y < GROUND - 20; y += 30) {
    rect(g, 4, y, 24, 2, "#2b323f");
    line(g, 8, y + 2, 24, y + 30, "#2b323f", 2);
    line(g, 24, y + 2, 8, y + 30, "#2b323f", 2);
  }
  rect(g, 0, 0, 70, 5, "#232935");
  rect(g, 0, 5, 70, 1, "#3f4758");

  // Floodlight on the right
  rect(g, 298, 54, 2, 77, "#141820");
  rect(g, 290, 50, 12, 4, "#2a2f3a");
  rect(g, 291, 54, 10, 1, "#f6f8ff");

  // Vignette, drawn over everything each frame
  const vig = document.createElement("canvas");
  vig.width = W;
  vig.height = H;
  const vg = vig.getContext("2d");
  const grad = vg.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, 200);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  vg.fillStyle = grad;
  vg.fillRect(0, 0, W, H);

  return { bg: c, vignette: vig, antennas, lamps };
}

// --- the agents ----------------------------------------------------------------------------
// Local sprite coordinates: facing right, feet at (0, 0), y grows downward (so up is negative).

// Heads, drawn with the top-left corner at (-4, -62).
const HEAD_P1 = [
  "..hhhhh...",
  ".hHHHHhh..",
  "dhhhhhhhh.",
  "dhhhhhsss.",
  "ddhhsssss.",
  ".dhssssess",
  ".dSssssssss",
  ".dSssssss..",
  "..Sssssmss",
  "..SSsssS..",
  "...SSsS...",
];
const HEAD_P2 = [
  "..hhhhh...",
  ".hHHHHhh..",
  "hhhhhhhhh.",
  "hhhhhhhhs.",
  "hhhhsssss.",
  "hhhssssess",
  "hhdSssssss",
  "hhdSsssss.",
  "hhdSssmss.",
  "hhd.SssS..",
  "hhd..SS...",
  "hhd.......",
  "hhd.......",
  "hd........",
  "d.........",
];

const LOOKS = [
  {
    // Agent 001: slicked blond hair, beige trench coat, white shirt, black tie, red rose, pistol
    head: HEAD_P1,
    hair: "#e6d18f", hairLight: "#f7ebbf", hairDark: "#b39455",
    skin: "#ecb98f", skinShade: "#c98f66", eye: "#2a1a14", lips: "#c07a64",
    coat: "#b08a62", coatShade: "#86684a", coatDeep: "#5e4833", coatLight: "#d0ad82",
    inner: "#ecece6", tie: "#141418", rose: true,
    pants: "#141519", pantsLight: "#2b2c35", shoes: "#0a0a0d", shoeLight: "#34343f", boots: false,
    hem: -15, weapon: "pistol",
  },
  {
    // Agent 002: long brown hair, bright green long coat, dark trousers, boots, sniper rifle
    head: HEAD_P2,
    hair: "#6b4226", hairLight: "#8e5c36", hairDark: "#44291a",
    skin: "#f0c4a0", skinShade: "#cf9a76", eye: "#2a1a14", lips: "#b8605a",
    coat: "#3aa14a", coatShade: "#2a7d38", coatDeep: "#1b5626", coatLight: "#62c86e",
    inner: "#1d3f24", tie: null, rose: false,
    pants: "#1b231c", pantsLight: "#2f3d31", shoes: "#0a0a0d", shoeLight: "#34343f", boots: true,
    hem: -12, weapon: "rifle",
  },
];

// Weapons, facing right. `grip` is where the firing hand holds it.
const WEAPON_ART = {
  pistol: {
    rows: [
      ".LLLLLLLLLLL.",
      "GGGGGGGGGGGGM",
      "GGGGGGGGGGGG.",
      ".GGGgGGG.....",
      ".GGG.G.......",
      ".GGG.........",
      ".GGG.........",
    ],
    grip: [2, 4],
    muzzle: [13, 1],
    eject: [7, 0],
  },
  rifle: {
    rows: [
      "...........SSSSSSSSSSS",
      "..........SLLLLLLLLLLB",
      "............GG.....GG",
      "GGGGGGGLLLLLLLLLLLLLLLLLLLLLLLLLLGGGGGGGGGGM",
      "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
      "GGGGG....GGG..GGG.......GG",
      "GGGG.....GG...GGG......G..G",
      "GGG...........GGG.....G....G",
      "......................G.....G",
    ],
    grip: [10, 5],
    muzzle: [44, 3],
    eject: [16, 3],
    support: [22, 4],
    magWell: [15, 8],
    bolt: [13, 2],
  },
};
const WEAPON_PAL = { G: "#1c1f27", L: "#6b7383", M: "#3a3e48", g: "#2e323c", S: "#2a2e37", B: "#8fdcff" };

function blit(g, rows, pal, x, y) {
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const c = pal[row[rx]];
      if (c) rect(g, x + rx, y + ry, 1, 1, c);
    }
  });
}

// --- sprite agents -------------------------------------------------------------------------
// The agents are PNGs in site/public/sprites (see sprites.json there). Each agent has poses
// (pistol, rifle, shield); each pose is two layers: the body, and the weapon with the arm/hands
// holding it, which turns around the shoulder to animate. Until they load (or if they're missing)
// the built-in drawn agents are used instead.

let SPRITES = null;
let BARRIER = null; // { cyan, red, w, h }: the shield barrier, and the red version for COUNTER
let manifest = null;

function makeBarrier(image) {
  const cyan = document.createElement("canvas");
  cyan.width = image.width;
  cyan.height = image.height;
  cyan.getContext("2d").drawImage(image, 0, 0);
  const red = document.createElement("canvas");
  red.width = image.width;
  red.height = image.height;
  const rg = red.getContext("2d");
  rg.drawImage(image, 0, 0);
  const px = rg.getImageData(0, 0, red.width, red.height);
  for (let k = 0; k < px.data.length; k += 4) {
    const l = (3 * px.data[k] + 6 * px.data[k + 1] + px.data[k + 2]) / 10;
    px.data[k] = Math.min(255, l * 1.25 + 45);
    px.data[k + 1] = l * 0.35;
    px.data[k + 2] = l * 0.3;
  }
  rg.putImageData(px, 0, 0);
  return { cyan, red, w: image.width, h: image.height };
}

function loadSprites() {
  const img = (file) => new Promise((ok, fail) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = fail;
    im.src = `/sprites/${file}`;
  });
  return fetch("/sprites/sprites.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`sprites.json: ${r.status}`))))
    .then((m) => (manifest = m))
    .then((m) => Promise.all(["agent1", "agent2"].map(async (k) => {
      const poses = {};
      for (const [name, pose] of Object.entries(m[k])) {
        if (pose && typeof pose === "object") {
          const [body, weapon] = await Promise.all([img(pose.body), img(pose.weapon)]);
          poses[name] = { ...pose, body, weapon };
        }
      }
      return { idle: poses[m[k].idle] ? m[k].idle : Object.keys(poses)[0], poses };
    })))
    .then(async (list) => {
      if (manifest.barrier?.image) BARRIER = makeBarrier(await img(manifest.barrier.image));
      SPRITES = list;
    })
    .catch((err) => { console.warn("Duel sprites not loaded, using built-in agents:", err); });
}

// Which pose each move uses. Reloads are always done with the pistol.
const MOVE_POSE = { SHOOT: "pistol", RELOAD: "pistol", SNIPE: "rifle", SHIELD: "shield", COUNTER: "shield" };

function spriteFor(i, action) {
  const set = SPRITES[i];
  return set.poses[MOVE_POSE[action]] || set.poses[set.idle];
}

/** A point of an agent's PNG relative to the feet, with the weapon layer turned by `angle` around the pivot. */
function spritePoint(S, p, angle = 0) {
  const dx = p[0] - S.pivot[0];
  const dy = p[1] - S.pivot[1];
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  return [S.pivot[0] - S.feet[0] + dx * c - dy * sn, S.pivot[1] - S.feet[1] + dx * sn + dy * c];
}

function lerpFrames(frames, e, key) {
  let i = 0;
  while (i < frames.length - 2 && e >= frames[i + 1].t) i++;
  const f0 = frames[i];
  const f1 = frames[i + 1];
  const p = clamp01((e - f0.t) / (f1.t - f0.t));
  const a = f0[key];
  const b = f1[key];
  return Array.isArray(a) ? [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p] : a + (b - a) * p;
}

// Weapon lowered while the free hand fetches a magazine from the belt, seats it and racks the action.
const SPRITE_RELOAD_ANGLE = [{ t: 0, v: 0 }, { t: 120, v: 0.5 }, { t: 560, v: 0.5 }, { t: 680, v: 0 }];

function spriteAngle(a, e) {
  switch (a.pose) {
    case "recoil": return -0.2;
    case "reload": return lerpFrames(SPRITE_RELOAD_ANGLE, e, "v");
    case "shield": return 0; // the shield pose already holds the pistol low
    case "counter": return e >= COUNTER_RAISE && e < COUNTER_LOWER ? lerpFrames(COUNTER_AIM, e, "v") : 0;
    case "hurt": return 0.35;
    case "victory": return -0.95;
    default: return 0;
  }
}

/** The free hand during a reload, relative to the feet (null when it isn't showing). */
function spriteReloadHand(S, angle, e) {
  if (e < 120 || e > 620) return null;
  const belt = [-4, -24];
  const grip = spritePoint(S, S.grip, angle);
  const rackFront = spritePoint(S, [S.grip[0] + 9, S.grip[1] - 4], angle);
  const rackBack = spritePoint(S, [S.grip[0] + 2, S.grip[1] - 4], angle);
  const frames = [
    { t: 120, p: belt }, { t: 250, p: belt }, { t: 370, p: grip },
    { t: 440, p: rackFront }, { t: 520, p: rackBack }, { t: 620, p: belt },
  ];
  return { p: lerpFrames(frames, e, "p"), carry: e >= 250 && e < 370 };
}

function drawSpriteAgent(g, i, a) {
  const S = a.spr;
  g.drawImage(S.body, -S.feet[0], -S.feet[1]);
  if (!a.hideWeapon) {
    g.save();
    g.translate(S.pivot[0] - S.feet[0] + (a.pose === "recoil" ? -1 : 0), S.pivot[1] - S.feet[1]);
    if (a.spriteAngle) g.rotate(a.spriteAngle);
    g.drawImage(S.weapon, -S.pivot[0], -S.pivot[1]);
    g.restore();
  }
  if (a.reloadHand) {
    const [x, y] = a.reloadHand.p.map(Math.round);
    if (a.reloadHand.carry) {
      rect(g, x - 1, y - 5, 3, 5, GUN);
      rect(g, x - 1, y - 5, 3, 1, BRASS);
    }
    rect(g, x - 1, y - 1, 3, 3, LOOKS[i].skin);
    rect(g, x - 1, y + 1, 3, 1, LOOKS[i].skinShade);
  }
}

let weaponCanvases = null;
function weaponCanvas(type) {
  if (!weaponCanvases) {
    weaponCanvases = {};
    for (const [name, art] of Object.entries(WEAPON_ART)) {
      const c = document.createElement("canvas");
      c.width = Math.max(...art.rows.map((r) => r.length)) + 2; // +1px border for the rim
      c.height = art.rows.length + 2;
      const wg = c.getContext("2d");
      blit(wg, art.rows, WEAPON_PAL, 1, 1);
      // Rim light: a faint cool outline so black guns still read against the night
      const img = wg.getImageData(0, 0, c.width, c.height);
      const solid = (x, y) => x >= 0 && y >= 0 && x < c.width && y < c.height && img.data[(y * c.width + x) * 4 + 3] > 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) {
            rect(wg, x, y, 1, 1, "rgba(150,165,190,0.45)");
          }
        }
      }
      weaponCanvases[name] = c;
    }
  }
  return weaponCanvases[type];
}

/** A point of a weapon (in its own pixel coordinates) placed with its grip at `hand`, turned by `angle`. */
function wpt(hand, angle, type, p) {
  const art = WEAPON_ART[type];
  const dx = p[0] - art.grip[0];
  const dy = p[1] - art.grip[1];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [hand[0] + dx * c - dy * s, hand[1] + dx * s + dy * c];
}

function drawWeapon(g, type, hand, angle) {
  const art = WEAPON_ART[type];
  g.save();
  g.translate(Math.round(hand[0]), Math.round(hand[1]));
  if (angle) g.rotate(angle);
  g.drawImage(weaponCanvas(type), -art.grip[0] - 1, -art.grip[1] - 1);
  g.restore();
}

/** A thick pixel limb, with a lighter top edge when `edge` is given. */
function limb(g, x0, y0, x1, y1, w, color, edge) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const h = Math.floor(w / 2);
  for (let k = 0; k <= n; k++) {
    rect(g, Math.round(x0 + ((x1 - x0) * k) / n) - h, Math.round(y0 + ((y1 - y0) * k) / n) - h, w, w, color);
  }
  if (edge) {
    for (let k = 0; k <= n; k++) {
      rect(g, Math.round(x0 + ((x1 - x0) * k) / n) - h, Math.round(y0 + ((y1 - y0) * k) / n) - h, w, 1, edge);
    }
  }
}

const FRONT_SHOULDER = [3, -46];
const BACK_SHOULDER = [-1, -46];
const HANG = [-10, -33]; // back hand resting by the hip
const POUCH = [-4, -31]; // spare magazines on the belt
const pistolAt = (p) => (hand, a) => wpt(hand, a, "pistol", p);
const rifleAt = (p) => (hand, a) => wpt(hand, a, "rifle", p);
const SUPPORT = rifleAt(WEAPON_ART.rifle.support);

// Reload: lower the weapon, drop the empty magazine, fetch a fresh one from the belt,
// seat it, then rack the slide (pistol) or work the bolt (rifle).
const RELOAD = {
  pistol: [
    { t: 0, hand: [18, -47], a: 0, back: null },
    { t: 120, hand: [13, -40], a: 0.6, back: HANG },
    { t: 250, hand: [13, -40], a: 0.6, back: POUCH, carry: true },
    { t: 370, hand: [13, -40], a: 0.6, back: pistolAt([2, 7]), carry: true },
    { t: 440, hand: [13, -40], a: 0.6, back: pistolAt([10, 0]) },
    { t: 520, hand: [13, -40], a: 0.6, back: pistolAt([4, 0]) },
    { t: 660, hand: [18, -47], a: 0, back: null },
  ],
  rifle: [
    { t: 0, hand: [11, -42], a: 0, back: SUPPORT },
    { t: 120, hand: [10, -45], a: -0.3, back: HANG },
    { t: 250, hand: [10, -45], a: -0.3, back: POUCH, carry: true },
    { t: 360, hand: [10, -45], a: -0.3, back: rifleAt(WEAPON_ART.rifle.magWell), carry: true },
    { t: 430, hand: [10, -45], a: -0.3, back: rifleAt([13, 2]) },
    { t: 500, hand: [10, -45], a: -0.3, back: rifleAt([8, 2]) },
    { t: 570, hand: [10, -45], a: -0.3, back: rifleAt([13, 2]) },
    { t: 680, hand: [11, -42], a: 0, back: SUPPORT },
  ],
};

const resolvePt = (b, hand, a) => (typeof b === "function" ? b(hand, a) : b);

function reloadRig(weapon, e) {
  const frames = RELOAD[weapon];
  let i = 0;
  while (i < frames.length - 2 && e >= frames[i + 1].t) i++;
  const f0 = frames[i];
  const f1 = frames[i + 1];
  const p = clamp01((e - f0.t) / (f1.t - f0.t));
  const hand = [f0.hand[0] + (f1.hand[0] - f0.hand[0]) * p, f0.hand[1] + (f1.hand[1] - f0.hand[1]) * p];
  const a = f0.a + (f1.a - f0.a) * p;
  let back = null;
  if (f0.back || f1.back) {
    const b0 = resolvePt(f0.back, hand, a) || HANG;
    const b1 = resolvePt(f1.back, hand, a) || HANG;
    back = [b0[0] + (b1[0] - b0[0]) * p, b0[1] + (b1[1] - b0[1]) * p];
  }
  return { weapon, hand, angle: a, back, carry: Boolean(f0.carry && back) };
}

/** Where the arms and the weapon are for a pose. */
function rig(pose, weapon, e) {
  const rifle = weapon === "rifle";
  const withSupport = (r) => (rifle && r.weapon ? { ...r, back: SUPPORT(r.hand, r.angle) } : r);
  switch (pose) {
    case "recoil":
      return withSupport(rifle ? { weapon, hand: [9, -43], angle: -0.14 } : { weapon, hand: [16, -49], angle: -0.4 });
    case "reload":
      return reloadRig(rifle ? "rifle" : "pistol", e);
    case "shield":
      // weapon lowered in one hand, the other forearm raised as a guard behind the barrier
      return { weapon, hand: rifle ? [8, -36] : [10, -36], angle: rifle ? 0.35 : 1.1, back: [12, -58] };
    case "counter":
      return withSupport(rifle ? { weapon, hand: [10, -46], angle: -0.55 } : { weapon, hand: [15, -47], angle: -0.9 });
    case "fumble":
      return { weapon: null, hand: [9, -60], angle: 0, back: null };
    case "hurt":
      return { weapon: weapon === "none" ? null : weapon, hand: rifle ? [8, -36] : [11, -36], angle: rifle ? 0.45 : 1.0, back: null };
    case "victory":
      return { weapon, hand: rifle ? [8, -60] : [6, -64], angle: rifle ? -1.3 : -1.45, back: null };
    default: // aim
      return withSupport(rifle ? { weapon, hand: [11, -42], angle: 0 } : { weapon, hand: [18, -47], angle: 0 });
  }
}

const MUZZLE = {
  pistol: wpt(rig("aim", "pistol", 0).hand, 0, "pistol", WEAPON_ART.pistol.muzzle),
  rifle: wpt(rig("aim", "rifle", 0).hand, 0, "rifle", WEAPON_ART.rifle.muzzle),
};

function drawHand(g, L, p) {
  const x = Math.round(p[0]);
  const y = Math.round(p[1]);
  rect(g, x - 1, y - 1, 3, 3, L.skin);
  rect(g, x - 1, y + 1, 3, 1, L.skinShade);
}

function drawBody(g, L, lean, flutter) {
  const u = lean;
  const pal = { h: L.hair, H: L.hairLight, d: L.hairDark, s: L.skin, S: L.skinShade, e: L.eye, m: L.lips };

  // Legs in a wide stance: back leg trailing, front leg forward
  limb(g, -3, -26, -6, -14, 4, L.pants);
  limb(g, -6, -14, -10, -4, 3, L.pants);
  limb(g, 3, -26, 7, -15, 4, L.pants);
  limb(g, 7, -15, 9, -4, 3, L.pants);
  limb(g, 9, -14, 10, -5, 1, L.pantsLight);
  if (L.boots) {
    rect(g, -12, -9, 4, 6, L.shoes);
    rect(g, 7, -9, 4, 6, L.shoes);
    rect(g, 10, -9, 1, 6, L.shoeLight);
  }
  rect(g, -14, -3, 7, 3, L.shoes);
  rect(g, -14, -3, 7, 1, L.shoeLight);
  rect(g, 7, -3, 8, 3, L.shoes);
  rect(g, 7, -3, 8, 1, L.shoeLight);

  // Long coat, flaring behind; it opens below the belt so the legs show
  const top = -48;
  const edges = (y) => {
    const t = (y - top) / (L.hem - top);
    return [-7 - Math.round(t * t * 7) - (y > L.hem - 5 ? flutter : 0) + u, 6 + Math.round(t * 2) + u];
  };
  for (let y = top; y <= L.hem; y++) {
    const [xb, xf] = edges(y);
    if (y <= -31) {
      rect(g, xb, y, xf - xb + 1, 1, L.coat);
    } else {
      const gap0 = u;
      const gap1 = 3 + u + Math.round((y + 31) / 5);
      rect(g, xb, y, gap0 - xb, 1, L.coat);
      rect(g, gap1, y, xf - gap1 + 1, 1, L.coat);
      rect(g, gap0 - 1, y, 1, 1, L.coatLight);
      rect(g, gap1, y, 1, 1, L.coatShade);
      rect(g, Math.round(xb / 2), y, 1, 1, L.coatShade); // fold
    }
    rect(g, xb, y, 2, 1, L.coatDeep);
    rect(g, xb + 2, y, 2, 1, L.coatShade);
    rect(g, xf, y, 1, 1, L.coatLight);
  }
  // Shoulders and collar
  rect(g, -8 + u, -48, 15, 1, L.coatLight);
  rect(g, -6 + u, -50, 4, 3, L.coatShade);
  // Open front: shirt, lapels, tie, rose
  for (let y = -48; y <= -34; y++) {
    const w = Math.max(1, 4 - Math.floor((y + 48) / 4));
    rect(g, 1 + u, y, w, 1, L.inner);
    rect(g, u, y, 1, 1, L.coatLight);
    rect(g, 1 + w + u, y, 1, 1, L.coatLight);
  }
  if (L.tie) {
    rect(g, 1 + u, -48, 3, 1, L.tie);
    rect(g, 2 + u, -47, 1, 12, L.tie);
  }
  if (L.rose) {
    rect(g, -3 + u, -45, 2, 2, "#d02a3a");
    rect(g, -2 + u, -45, 1, 1, "#ff6070");
    rect(g, -3 + u, -43, 1, 1, "#2f6b2f");
  }
  // Belt with buckle
  const [bxb, bxf] = edges(-32);
  rect(g, bxb, -32, bxf - bxb + 1, 2, L.coatDeep);
  rect(g, u, -32, 3, 2, "#b8a060");
  // Neck and head
  rect(g, u, -51, 3, 3, L.skinShade);
  blit(g, L.head, pal, -4 + u, -62);
}

/** Draws one agent facing right with the feet at (0, 0). */
function drawAgent(g, L, a, now) {
  const r = a.rig;
  const flutter = Math.floor(now / 260) % 3 === 0 ? 1 : 0;
  // Back arm hangs behind the coat unless it's busy
  if (!r.back) {
    limb(g, -5, -46, -9, -34, 4, L.coatShade);
    drawHand(g, { ...L, skin: L.skinShade }, HANG);
  }
  drawBody(g, L, a.lean, flutter);
  // Firing arm, then the weapon in that hand
  const sh = [FRONT_SHOULDER[0] + a.lean, FRONT_SHOULDER[1]];
  limb(g, sh[0], sh[1], r.hand[0], r.hand[1], 4, L.coat, L.coatLight);
  if (r.weapon) drawWeapon(g, r.weapon, r.hand, r.angle);
  drawHand(g, L, r.hand);
  // Second arm when it supports the rifle, guards, or reloads
  if (r.back) {
    const bs = [BACK_SHOULDER[0] + a.lean, BACK_SHOULDER[1]];
    limb(g, bs[0], bs[1], r.back[0], r.back[1], 4, L.coatShade, L.coat);
    if (r.carry) {
      rect(g, Math.round(r.back[0]) - 1, Math.round(r.back[1]) - 4, 3, 5, GUN);
      rect(g, Math.round(r.back[0]) - 1, Math.round(r.back[1]) - 4, 3, 1, BRASS);
    }
    drawHand(g, L, r.back);
  }
}

// --- one turn, as a function of time --------------------------------------------------------

function planTurn(s, e) {
  const pb = s.playback;
  const t = pb.currentTurn;
  const agents = [0, 1].map((i) => ({
    pose: "aim", weapon: LOOKS[i].weapon, flash: 0, fall: 0, lean: 0, action: null, hurtAt: null, koAt: null,
  }));
  const shots = [];

  if (t) {
    const acts = t.actions || [];
    const events = t.events || [];
    acts.forEach((act, i) => {
      const a = agents[i];
      a.action = act;
      if (act === "SHOOT") a.weapon = "pistol";
      if (act === "SNIPE") a.weapon = "rifle";
      if (act === "SHOOT" || act === "SNIPE") a.pose = e >= T_FIRE && e < T_FIRE + 130 ? "recoil" : "aim";
      else if (act === "SHIELD") a.pose = "shield";
      else if (act === "COUNTER") a.pose = "counter";
      else if (act === "RELOAD") a.pose = "reload";
      // FUMBLE: no animation; the agent just holds the gun up and doesn't fire
      if (a.pose === "recoil") a.lean = a.weapon === "rifle" ? -2 : -1;
    });

    // Every SHOOT/SNIPE fires; the events only decide how the shot ends.
    acts.forEach((act, att) => {
      if (act !== "SHOOT" && act !== "SNIPE") return;
      const def = 1 - att;
      const ev = events.find((v) => v.by === att);
      const travel = TRAVEL[act] || 200;
      const impact = T_FIRE + travel;
      let end = "miss";
      if (ev?.type === "hit") {
        end = "hit";
        agents[def].hurtAt = impact;
      } else if (ev?.type === "blocked") {
        end = ev.with === "SHIELD" ? "shield" : ev.with === "COUNTER" ? "counter" : "clash";
      } else if (ev?.type === "reflected") {
        end = "reflect";
        agents[att].hurtAt = impact + REFLECT_BACK;
      }
      shots.push({
        att, def, action: act, end,
        impact: end === "clash" ? T_FIRE + Math.round(travel / 2) : impact,
        back: impact + REFLECT_BACK,
      });
    });

    agents.forEach((a, i) => {
      if (a.hurtAt !== null && e >= a.hurtAt && e < a.hurtAt + HURT_MS) {
        a.pose = "hurt";
        a.flash = 1 - (e - a.hurtAt) / HURT_MS;
        a.lean = -2;
      }
      const hp = t.state?.[i]?.hp;
      if (hp !== undefined && hp <= 0) {
        a.koAt = (a.hurtAt ?? T_FIRE + 200) + 80;
        if (e >= a.koAt) {
          a.pose = "hurt";
          a.fall = clamp01((e - a.koAt) / FALL_MS);
        }
      }
    });

    if (pb.isMatchComplete && (s.winnerSide === 0 || s.winnerSide === 1)) {
      const w = agents[s.winnerSide];
      Object.assign(w, { pose: "victory", fall: 0, flash: 0, lean: 0, weapon: LOOKS[s.winnerSide].weapon });
      const l = agents[1 - s.winnerSide];
      if (l.fall === 0) l.pose = "hurt";
    }
  }

  agents.forEach((a) => {
    a.rig = rig(a.pose, a.weapon, e);
    if (SPRITES) {
      const idx = agents.indexOf(a);
      const aiming = a.pose === "counter" && e >= COUNTER_RAISE && e < COUNTER_LOWER;
      const S = aiming ? SPRITES[idx].poses.pistol || spriteFor(idx, a.action) : spriteFor(idx, a.action);
      a.spr = S;
      // while falling, the weapon settles flat on the ground instead of pointing at the sky
      a.spriteAngle = a.fall > 0 ? (Math.PI / 2) * easeOut(a.fall) : spriteAngle(a, e);
      a.hideWeapon = a.pose === "fumble";
      a.reloadHand = null; // the weapon lowers and racks; no magazine flying to it
    }
    if (a.fall > 0 && a.rig.weapon) {
      a.dropped = a.rig.weapon; // it slips out of the hand and lands beside them
      a.rig = { ...a.rig, weapon: null };
    }
  });
  return { agents, shots };
}

// --- the scene ----------------------------------------------------------------------------

function createScene() {
  const { bg, vignette, antennas, lamps } = buildBackground();
  const r = rng(99);
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = SW;
    c.height = SH;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    return { c, g };
  };
  const drops = [];
  for (let i = 0; i < 230; i++) {
    const near = i % 3 === 0;
    drops.push({
      x: r() * W, y: r() * H, near,
      v: near ? 260 + r() * 90 : 170 + r() * 70,
      len: near ? 6 + Math.floor(r() * 4) : 3 + Math.floor(r() * 3),
      land: near ? GROUND + 2 + r() * (H - GROUND - 2) : HORIZON + r() * (GROUND - HORIZON + 30),
    });
  }
  return {
    bg, vignette, antennas, lamps, drops,
    sprites: [mk(), mk()],
    shadows: [mk(), mk()],
    splashes: [],
    particles: [],
    casings: [],
    floats: [],
    spawned: new Set(),
    turnKey: null,
    gameKey: null,
    turnStart: 0,
    shake: 0,
    nextBolt: performance.now() + 8000 + Math.random() * 12000,
    bolt: null,
    last: performance.now(),
  };
}

function spawnSparks(sc, x, y, colors, n, dir = 0) {
  for (let k = 0; k < n; k++) {
    sc.particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 120 + dir * 60,
      vy: -Math.random() * 90 - 10,
      life: 0, max: 220 + Math.random() * 200,
      color: colors[k % colors.length], g: 260,
    });
  }
}

function addFloat(sc, text, x, y, color, now, scale = 1) {
  sc.floats.push({ text, x, y, color, t0: now, dur: 800, scale });
}

function drawLights(g, sc, now) {
  g.save();
  g.globalCompositeOperation = "lighter";
  // Floodlight cone and glow
  const cone = g.createLinearGradient(0, 56, 0, H);
  cone.addColorStop(0, "rgba(190,210,255,0.16)");
  cone.addColorStop(1, "rgba(190,210,255,0.02)");
  g.fillStyle = cone;
  g.beginPath();
  g.moveTo(292, 55);
  g.lineTo(301, 55);
  g.lineTo(W, H);
  g.lineTo(212, H);
  g.closePath();
  g.fill();
  const head = g.createRadialGradient(296, 54, 0, 296, 54, 22);
  head.addColorStop(0, "rgba(235,242,255,0.55)");
  head.addColorStop(1, "rgba(235,242,255,0)");
  g.fillStyle = head;
  g.fillRect(270, 30, 52, 50);
  // Warm pier lamps (one of them flickers)
  sc.lamps.forEach((lx, idx) => {
    const flicker = idx === 2 ? (Math.sin(now / 90) > 0.93 ? 0.35 : 1) : 1;
    const glow = g.createRadialGradient(lx, 100, 0, lx, 100, 11);
    glow.addColorStop(0, `rgba(255,214,150,${0.45 * flicker})`);
    glow.addColorStop(1, "rgba(255,214,150,0)");
    g.fillStyle = glow;
    g.fillRect(lx - 11, 89, 22, 22);
  });
  // Backlight breathing
  const back = g.createLinearGradient(0, 0, 30, 0);
  back.addColorStop(0, `rgba(220,232,250,${0.08 + 0.03 * Math.sin(now / 900)})`);
  back.addColorStop(1, "rgba(220,232,250,0)");
  g.fillStyle = back;
  g.fillRect(0, 0, 30, H);
  g.restore();
  // Aircraft warning lights
  if (Math.floor(now / 1200) % 2 === 0) {
    for (const [ax, ay] of sc.antennas) rect(g, ax, ay, 1, 1, "#ff4b4b");
  }
}

function drawRain(g, sc, dt, near) {
  for (const d of sc.drops) {
    if (d.near !== near) continue;
    d.y += d.v * dt;
    if (d.y > d.land) {
      if (d.land > GROUND) sc.splashes.push({ x: Math.round(d.x), y: Math.round(d.land), t: 0 });
      d.y = -Math.random() * 40;
      d.x = Math.random() * W;
    }
    const inFlood = d.x > 300 - (d.y - 55) * 0.72 && d.y > 55;
    const inBack = d.x < 34;
    const a = (near ? 0.42 : 0.2) + (inFlood || inBack ? 0.3 : 0);
    rect(g, Math.round(d.x), Math.round(d.y), 1, d.len, `rgba(200,215,240,${a})`);
  }
}

function drawSplashes(g, sc, dt) {
  sc.splashes = sc.splashes.filter((s) => (s.t += dt * 1000) < 160);
  for (const s of sc.splashes) {
    const k = s.t < 80 ? 1 : 2;
    g.fillStyle = "rgba(200,215,240,0.45)";
    g.fillRect(s.x - k, s.y - (k === 1 ? 1 : 0), 1, 1);
    g.fillRect(s.x + k, s.y - (k === 1 ? 1 : 0), 1, 1);
  }
}

function drawAgentWorld(g, sc, i, a, now) {
  const { c, g: sg } = sc.sprites[i];
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.clearRect(0, 0, SW, SH);
  sg.save();
  sg.translate(OX, OY);
  if (DIRS[i] < 0) sg.scale(-1, 1);
  if (a.fall > 0) {
    const f = easeOut(a.fall);
    sg.translate(0, -(SPRITES ? 14 : 6) * f); // keep the lying body on the floor
    sg.rotate((-Math.PI / 2) * f); // falls backwards, away from the opponent
  }
  if (SPRITES) drawSpriteAgent(sg, i, a);
  else drawAgent(sg, LOOKS[i], a, now);
  sg.restore();
  if (a.flash > 0) {
    sg.globalCompositeOperation = "source-atop";
    sg.fillStyle = `rgba(255,70,60,${0.5 * a.flash})`;
    sg.fillRect(0, 0, SW, SH);
    sg.globalCompositeOperation = "source-over";
  }
  const sh = sc.shadows[i];
  sh.g.clearRect(0, 0, SW, SH);
  sh.g.globalCompositeOperation = "source-over";
  sh.g.drawImage(c, 0, 0);
  sh.g.globalCompositeOperation = "source-in";
  sh.g.fillStyle = "#03050a";
  sh.g.fillRect(0, 0, SW, SH);
  sh.g.globalCompositeOperation = "source-over";

  const x = XS[i] - (a.fall === 0 ? DIRS[i] * Math.round(3 * a.flash) : 0);
  const y = FEET;

  g.save();
  g.beginPath();
  g.rect(0, GROUND, W, H - GROUND); // already offset by the shake transform
  g.clip();
  // Cast shadows: the backlight on the left throws them right, the floodlight on the right throws them left.
  const near = i === 0;
  const casts = [
    { k: near ? 0.75 : 1.35, alpha: near ? 0.5 : 0.22 },
    { k: near ? -1.25 : -0.6, alpha: near ? 0.16 : 0.42 },
  ];
  if (sc.boltLight > 0) casts.push({ k: 0.25, alpha: 0.5 * sc.boltLight });
  for (const cst of casts) {
    g.globalAlpha = cst.alpha;
    g.setTransform(1, 0, -cst.k, -0.16, x + sc.ox, y + sc.oy);
    g.drawImage(sh.c, -OX, -OY);
  }
  g.setTransform(1, 0, 0, 1, sc.ox, sc.oy);
  // Contact shadow
  g.globalAlpha = 0.55;
  rect(g, x - 15, y, 31, 1, "#000");
  rect(g, x - 11, y + 1, 23, 1, "#000");
  // Rippling reflection in the wet floor
  g.globalAlpha = 0.2;
  for (let row = 0; row < OY; row++) {
    const src = OY - 1 - row;
    const off = row > 5 ? Math.round(Math.sin(now / 240 + row * 0.5)) : 0;
    g.drawImage(c, 0, src, SW, 1, x - OX + off, y + 2 + row, SW, 1);
  }
  g.restore();

  if (a.dropped && !SPRITES) {
    const f = easeOut(a.fall);
    g.save();
    g.translate(Math.round(x + DIRS[i] * 14), Math.round(y - 3 - (1 - f) * 30));
    g.scale(DIRS[i], 1);
    g.drawImage(weaponCanvas(a.dropped), -WEAPON_ART[a.dropped].grip[0], -2);
    g.restore();
  }
  g.drawImage(c, x - OX, y - OY);
}

function drawDefences(g, plan, e, now) {
  plan.agents.forEach((a, i) => {
    if (a.fall > 0) return;
    const dir = DIRS[i];
    const blockedHere = plan.shots.find((s) => s.def === i && (s.end === "shield" || s.end === "counter" || s.end === "reflect"));
    const flare = blockedHere && e >= blockedHere.impact && e < blockedHere.impact + 200 ? 1 : 0;
    if ((a.action === "SHIELD" || a.action === "COUNTER") && e > 40 && e < 720 && BARRIER) {
      const counter = a.action === "COUNTER";
      const back = SHIELD_BACK + (counter ? counterJerk(e) : 0);
      const img = counter && e >= COUNTER_HIT ? BARRIER.red : BARRIER.cyan;
      g.save();
      g.translate(XS[i] + dir * back, FEET - BARRIER.h - 3);
      g.scale(dir, 1);
      g.globalAlpha = clamp01((e - 40) / 60) * (0.85 + 0.15 * Math.sin(now / 90));
      g.drawImage(img, 0, 0);
      if (flare) {
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 0.7;
        g.drawImage(img, 0, 0);
      }
      g.restore();
    } else if ((a.action === "SHIELD" || a.action === "COUNTER") && e > 40 && e < 720) {
      // built-in fallback when shield.png isn't available
      const counter = a.action === "COUNTER";
      const bx = XS[i] + dir * (SHIELD_X + (counter ? counterJerk(e) : 0));
      const cy = FEET - 36;
      const rgb = counter && e >= COUNTER_HIT ? (flare ? "255,170,160" : "255,70,60") : "130,225,255";
      const alpha = Math.min(1, 0.45 + 0.2 * Math.sin(now / 55) + flare * 0.6);
      for (let k = 0; k < 96; k++) {
        const ang = (k / 96) * Math.PI * 2;
        const cx = Math.cos(ang);
        if (cx * dir < -0.25) continue;
        rect(g, Math.round(bx + cx * 6), Math.round(cy + Math.sin(ang) * 27), 1, 1, `rgba(${rgb},${alpha})`);
      }
      for (let yy = cy - 24; yy <= cy + 24; yy += 2) {
        rect(g, bx + ((yy / 2) % 2 ? 1 : 0) * dir, yy, 1, 1, `rgba(${rgb},${0.18 + flare * 0.4})`);
        rect(g, bx + (2 + ((yy / 2) % 2 ? 1 : 0)) * dir, yy + 1, 1, 1, `rgba(${rgb},${0.1 + flare * 0.3})`);
      }
    }
  });
}

const SHIELD_BACK = 55; // the barrier's flat back edge, in front of the fully aimed pistol
const SHIELD_W = 18; // barrier width (shield.png); enemy shots stop at its curved front
const SHIELD_X = SHIELD_BACK + SHIELD_W;

/** How far a COUNTER shield has been knocked forward by its owner's shot. */
function counterJerk(e) {
  if (e < COUNTER_HIT) return 0;
  const t = e - COUNTER_HIT;
  return t < 45 ? Math.round((14 * t) / 45) : Math.max(4, Math.round(14 - (t - 45) / 20));
}

function weaponFor(action) {
  return action === "SNIPE" ? "rifle" : "pistol";
}

function muzzleWorld(i, weapon, angle = 0) {
  const S = SPRITES && (SPRITES[i].poses[weapon] || SPRITES[i].poses[SPRITES[i].idle]);
  const [mx, my] = S ? spritePoint(S, S.muzzle, angle) : MUZZLE[weapon] || MUZZLE.pistol;
  return [Math.round(XS[i] + DIRS[i] * mx), Math.round(FEET + my)];
}

function shotEnd(s) {
  const [mx, my] = muzzleWorld(s.att, weaponFor(s.action));
  if (s.end === "hit") return [XS[s.def] + DIRS[s.def] * 3, FEET - 40];
  if (s.end === "shield") return [XS[s.def] + DIRS[s.def] * SHIELD_X, my];
  if (s.end === "counter" || s.end === "reflect") return [XS[s.def] + DIRS[s.def] * (SHIELD_X + counterJerk(s.impact)), my];
  if (s.end === "clash") {
    const [ox] = muzzleWorld(s.def, "rifle");
    return [Math.round((mx + ox) / 2), my];
  }
  return [DIRS[s.att] > 0 ? W + 8 : -8, my]; // miss: flies off screen
}

function drawShots(g, plan, e) {
  for (const s of plan.shots) {
    const [sx, sy] = muzzleWorld(s.att, weaponFor(s.action));
    const [ex, ey] = shotEnd(s);
    if (s.action === "SNIPE") {
      if (e < T_FIRE && Math.floor(e / 40) % 2 === 0) {
        // laser sight on the target's head
        const [hx, hy] = [XS[s.def], FEET - 56];
        for (let k = 0; k <= 1; k += 0.025) rect(g, Math.round(sx + (hx - sx) * k), Math.round(sy + (hy - sy) * k), 1, 1, "rgba(255,60,60,0.7)");
        rect(g, hx - 1, hy - 1, 3, 3, "rgba(255,60,60,0.5)");
      }
      if (e >= T_FIRE && e < T_FIRE + 300) {
        const p = clamp01((e - T_FIRE) / (s.impact - T_FIRE));
        const fade = 1 - (e - T_FIRE) / 300;
        const hx = sx + (ex - sx) * p;
        line(g, sx, sy - 1, hx, ey - 1, `rgba(110,215,255,${0.45 * fade})`);
        line(g, sx, sy, hx, ey, `rgba(240,255,255,${fade})`);
        line(g, sx, sy + 1, hx, ey + 1, `rgba(110,215,255,${0.45 * fade})`);
      }
    } else if (e >= T_FIRE && e < s.impact) {
      const p = (e - T_FIRE) / (s.impact - T_FIRE);
      const bx = Math.round(sx + (ex - sx) * p);
      const by = Math.round(sy + (ey - sy) * p);
      const d = Math.sign(ex - sx) || 1;
      for (let k = 1; k <= 10; k++) rect(g, bx - d * k, by, 1, 1, `rgba(255,200,110,${0.75 - k * 0.07})`);
      rect(g, bx, by - 1, 3 * d, 1, "rgba(255,230,160,0.35)");
      rect(g, bx, by + 1, 3 * d, 1, "rgba(255,230,160,0.35)");
      rect(g, bx, by, 4 * d, 1, "#fff2b0");
    }
    if (s.end === "reflect" && e >= s.impact && e < s.back) {
      const p = (e - s.impact) / (s.back - s.impact);
      const tx = XS[s.att] + DIRS[s.att] * 3;
      const ty = FEET - 40;
      const bx = Math.round(ex + (tx - ex) * p);
      const by = Math.round(ey + (ty - ey) * p);
      const d = Math.sign(tx - ex) || 1;
      for (let k = 1; k <= 10; k++) rect(g, bx - d * k, by, 1, 1, `rgba(255,80,70,${0.8 - k * 0.07})`);
      rect(g, bx, by - 1, 3 * d, 1, "rgba(255,120,110,0.4)");
      rect(g, bx, by + 1, 3 * d, 1, "rgba(255,120,110,0.4)");
      rect(g, bx, by, 4 * d, 1, "#ff6a5a");
    }
  }
  // COUNTER: the agent's own shot into their shield
  plan.agents.forEach((a, i) => {
    if (a.action !== "COUNTER" || a.fall > 0 || e < COUNTER_FIRE || e >= COUNTER_FIRE + 70) return;
    const d = DIRS[i];
    const [mx, my] = muzzleWorld(i, "pistol", 0);
    const tx = XS[i] + d * SHIELD_BACK; // the agent shoots the back of their own shield
    if (e < COUNTER_HIT) {
      const bx = Math.round(mx + (tx - mx) * ((e - COUNTER_FIRE) / (COUNTER_HIT - COUNTER_FIRE)));
      for (let k = 1; k <= 5; k++) rect(g, bx - d * k, my, 1, 1, `rgba(255,200,110,${0.7 - k * 0.12})`);
      rect(g, bx, my, 3 * d, 1, "#fff2b0");
    }
    if (e < COUNTER_FIRE + 50) {
      rect(g, mx, my - 1, 2 * d, 3, "#fff8dc");
      rect(g, mx + 2 * d, my, 3 * d, 1, "#ffd35a");
      g.save();
      g.globalCompositeOperation = "lighter";
      const glow = g.createRadialGradient(mx, my, 0, mx, my, 16);
      glow.addColorStop(0, "rgba(255,200,110,0.5)");
      glow.addColorStop(1, "rgba(255,200,110,0)");
      g.fillStyle = glow;
      g.fillRect(mx - 16, my - 16, 32, 32);
      g.restore();
    }
  });
  // Muzzle flashes, lighting up the agent and the wet ground
  for (const s of plan.shots) {
    if (e < T_FIRE || e >= T_FIRE + 80) continue;
    const w = weaponFor(s.action);
    const r = plan.agents[s.att].rig;
    let mx;
    let my;
    if (SPRITES) {
      [mx, my] = muzzleWorld(s.att, w, plan.agents[s.att].spriteAngle || 0);
    } else {
      const local = r.weapon === w ? wpt(r.hand, r.angle, w, WEAPON_ART[w].muzzle) : MUZZLE[w];
      mx = Math.round(XS[s.att] + DIRS[s.att] * local[0]);
      my = Math.round(FEET + local[1]);
    }
    const d = DIRS[s.att];
    const big = s.action === "SNIPE" ? 2 : 1;
    const flick = e < T_FIRE + 40 ? 1 : 0.6;
    rect(g, mx, my - 2, 3 * d, 5, "#fff8dc");
    rect(g, mx + 3 * d, my - 1, (4 + 3 * big) * d, 3, "#ffd35a");
    rect(g, mx + (7 + 3 * big) * d, my, (3 + 2 * big) * d, 1, "#ffb13b");
    rect(g, mx + 2 * d, my - 4 - big, 1, 2 + big, "#ffb13b");
    rect(g, mx + 2 * d, my + 3, 1, 2 + big, "#ffb13b");
    g.save();
    g.globalCompositeOperation = "lighter";
    const glow = g.createRadialGradient(mx, my, 0, mx, my, 22 + big * 8);
    glow.addColorStop(0, `rgba(255,200,110,${0.6 * flick})`);
    glow.addColorStop(1, "rgba(255,200,110,0)");
    g.fillStyle = glow;
    g.fillRect(mx - 40, my - 40, 80, 80);
    g.fillStyle = `rgba(255,190,110,${0.14 * flick})`;
    g.beginPath();
    g.ellipse(mx, FEET, 34, 6, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}

function spawnTurnEffects(sc, plan, e, now) {
  const once = (key, fn) => {
    if (!sc.spawned.has(key)) {
      sc.spawned.add(key);
      fn();
    }
  };
  const toWorld = (i, p) => [XS[i] + DIRS[i] * p[0], FEET + p[1]];
  plan.agents.forEach((a, i) => {
    const d = DIRS[i];
    if ((a.action === "SHOOT" || a.action === "SNIPE") && e >= T_FIRE) {
      once(`fire${i}`, () => {
        const w = weaponFor(a.action);
        const S = SPRITES && a.spr;
        const [cx, cy] = toWorld(i, S ? spritePoint(S, [S.grip[0] + 2, S.grip[1] - 5]) : wpt(rig("aim", w, 0).hand, 0, w, WEAPON_ART[w].eject));
        sc.particles.push({
          x: cx, y: cy, vx: -d * (30 + Math.random() * 30), vy: -80 - Math.random() * 30,
          life: 0, max: 5000, color: BRASS, g: 300, casing: true, floor: FEET + Math.floor(Math.random() * 8) - 2,
        });
        const [mx, my] = muzzleWorld(i, w);
        for (let k = 0; k < (w === "rifle" ? 7 : 4); k++) {
          sc.particles.push({
            x: mx + d * k * 2, y: my - 1, vx: d * (10 + Math.random() * 20), vy: -10 - Math.random() * 15,
            life: 0, max: 500 + Math.random() * 400, color: "rgba(185,190,200,0.55)", g: -15, size: 2,
          });
        }
      });
    }
    if (a.action === "RELOAD") {
      const w = a.weapon === "rifle" ? "rifle" : "pistol";
      if (e >= 130) {
        once(`magdrop${i}`, () => {
          const r = RELOAD[w][1];
          const well = w === "rifle" ? WEAPON_ART.rifle.magWell : [2, 7];
          const S = SPRITES && a.spr;
          const [px, py] = toWorld(i, S ? spritePoint(S, S.grip, 0.5) : wpt(r.hand, r.a, w, well));
          sc.particles.push({ x: px, y: py, vx: -d * 15, vy: 10, life: 0, max: 5000, color: GUN, g: 380, casing: true, vanish: true, floor: FEET, size: 3 });
        });
      }
      const clickAt = w === "rifle" ? 500 : 520;
      if (e >= clickAt) {
        once(`click${i}`, () => {
          const [px, py] = toWorld(i, (SPRITES && a.reloadHand?.p) || a.rig.back || a.rig.hand);
          spawnSparks(sc, px, py, ["#fff2c0", "#ffd36a"], 4);
          addFloat(sc, "+1", XS[i], FEET - 84, "#ffd36a", now, 2);
        });
      }
    }
    if (a.action === "COUNTER" && a.fall === 0) {
      if (e >= COUNTER_HIT) {
        once(`chit${i}`, () => {
          const [, my] = muzzleWorld(i, "pistol", 0);
          spawnSparks(sc, XS[i] + d * SHIELD_BACK, my, ["#ff5a4a", "#ffd0c8", "#ffffff"], 10, d);
          sc.shake = Math.max(sc.shake, 1.5);
        });
      }
    }
    if (a.koAt !== null && e >= a.koAt + FALL_MS) {
      once(`dust${i}`, () => {
        spawnSparks(sc, XS[i] - d * 30, FEET, ["rgba(170,180,200,0.6)", "rgba(120,130,150,0.6)"], 14);
        sc.shake = Math.max(sc.shake, 2);
      });
    }
  });
  for (const s of plan.shots) {
    const [ex, ey] = shotEnd(s);
    if (e >= s.impact && s.end !== "miss") {
      once(`impact${s.att}`, () => {
        if (s.end === "hit") {
          spawnSparks(sc, ex, ey, ["#ffcf6a", "#ff7a4a", "#fff2c0"], 10, -DIRS[s.def]);
          addFloat(sc, "-1", XS[s.def], FEET - 84, "#ff5a5a", now, 2);
          sc.shake = Math.max(sc.shake, s.action === "SNIPE" ? 3 : 2);
        } else if (s.end === "shield") {
          spawnSparks(sc, ex, ey, ["#8fe6ff", "#e6fbff"], 12, DIRS[s.def]);
          addFloat(sc, "BLOCK", XS[s.def], FEET - 84, "#8fe6ff", now);
        } else if (s.end === "counter") {
          spawnSparks(sc, ex, ey, ["#ffd36a", "#fff2c0"], 12, DIRS[s.def]);
          addFloat(sc, "BLOCK", XS[s.def], FEET - 84, "#8fe6ff", now);
        } else if (s.end === "reflect") {
          spawnSparks(sc, ex, ey, ["#ff5a4a", "#ffd0c8", "#ffffff"], 14, DIRS[s.def]);
          addFloat(sc, "REFLECT", XS[s.def], FEET - 84, "#ff6a5a", now);
        } else {
          once("clash", () => {
            spawnSparks(sc, ex, ey, ["#ffffff", "#9fe8ff", "#ffd36a"], 18);
            addFloat(sc, "CLASH", ex, ey - 18, "#e6fbff", now, 2);
            sc.shake = Math.max(sc.shake, 2);
          });
        }
      });
    }
    if (s.end === "reflect" && e >= s.back) {
      once(`back${s.att}`, () => {
        spawnSparks(sc, XS[s.att], FEET - 40, ["#ffcf6a", "#ff7a4a"], 10, -DIRS[s.att]);
        addFloat(sc, "-1", XS[s.att], FEET - 84, "#ff5a5a", now, 2);
        sc.shake = Math.max(sc.shake, 2);
      });
    }
  }
}

function drawParticles(g, sc, dt) {
  const keep = [];
  for (const p of sc.particles) {
    p.life += dt * 1000;
    p.vy += p.g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.casing && p.y >= p.floor) {
      if (Math.abs(p.vy) > 40) {
        p.y = p.floor;
        p.vy = -p.vy * 0.35;
        p.vx *= 0.5;
      } else if (p.vanish) {
        continue; // a dropped gun is picked back up for the next turn
      } else {
        if (sc.casings.length > 40) sc.casings.shift();
        sc.casings.push({ x: Math.round(p.x), y: Math.round(p.floor), color: p.color, size: p.size || 2 });
        continue;
      }
    }
    if (p.life < p.max) keep.push(p);
    const a = p.casing ? 1 : 1 - p.life / p.max;
    g.globalAlpha = Math.max(0, a);
    rect(g, Math.round(p.x), Math.round(p.y), p.size || (p.casing ? 2 : 1), 1, p.color);
  }
  g.globalAlpha = 1;
  sc.particles = keep;
}

function drawFloats(g, sc, now) {
  sc.floats = sc.floats.filter((f) => now - f.t0 < f.dur);
  for (const f of sc.floats) {
    const p = (now - f.t0) / f.dur;
    drawText(g, f.text, f.x, f.y - p * 14, f.color, f.scale, p > 0.6 ? (1 - p) / 0.4 : 1);
  }
}

function drawLightning(g, sc, now) {
  if (!sc.bolt && now >= sc.nextBolt) {
    const pts = [];
    let x = 60 + Math.random() * 200;
    for (let y = 0; y < 90; y += 6) {
      pts.push([x, y]);
      x += (Math.random() - 0.5) * 14;
    }
    sc.bolt = { t0: now, pts };
    sc.nextBolt = now + 14000 + Math.random() * 22000;
  }
  sc.boltLight = 0;
  if (!sc.bolt) return;
  const t = now - sc.bolt.t0;
  const I = t < 70 ? 1 : t < 130 ? 0.15 : t < 230 ? 0.7 : t < 400 ? 0.7 * (1 - (t - 230) / 170) : 0;
  if (t >= 400) {
    sc.bolt = null;
    return;
  }
  sc.boltLight = I;
  g.fillStyle = `rgba(205,218,255,${0.3 * I})`;
  g.fillRect(0, 0, W, HORIZON);
  if (t < 130 || (t > 150 && t < 230)) {
    const pts = sc.bolt.pts;
    for (let k = 1; k < pts.length; k++) line(g, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], `rgba(235,242,255,${0.9 * I})`);
  }
}

function drawOverlays(g, sc, s, plan, e, now) {
  const pb = s.playback;
  if (s.isBye) {
    drawText(g, "BYE", W / 2, 40, "#e8c98a", 3);
    drawText(g, "AUTOMATIC ADVANCE", W / 2, 62, "#c7d0e0", 1);
    return;
  }
  if (!pb.isMatchComplete) {
    s.names.forEach((n, i) => {
      if (plan.agents[i].fall === 0) drawText(g, n, XS[i], FEET - (SPRITES ? 68 : 74), "rgba(230,236,246,0.85)");
    });
  }
  if (pb.currentTurn && pb.turnIndex === 0 && !pb.isIntermission && !pb.isMatchComplete && e < 900) {
    drawText(g, `GAME ${pb.gameIndex + 1}`, W / 2, 30, "#e8c98a", 2, e > 600 ? (900 - e) / 300 : 1);
  }
  if (pb.isIntermission && pb.currentGame) {
    const res = pb.currentGame.result || {};
    const last = pb.currentTurn?.state || [];
    const kos = [0, 1].filter((i) => (last[i]?.hp ?? 1) <= 0).length;
    const title = kos === 2 ? "DOUBLE K.O." : kos === 1 ? "K.O." : res.winner === null || res.winner === undefined ? "DRAW" : "TIME";
    drawText(g, title, W / 2, 34, title === "DRAW" ? "#c7d0e0" : "#ff5a5a", 3);
    if (res.winner === 0 || res.winner === 1) drawText(g, `${s.names[res.winner]} TAKES THE GAME`, W / 2, 56, "#e8c98a");
  }
  if (pb.isMatchComplete && (s.winnerSide === 0 || s.winnerSide === 1)) {
    const x = XS[s.winnerSide];
    g.save();
    g.globalCompositeOperation = "lighter";
    const spot = g.createRadialGradient(x, FEET - 32, 0, x, FEET - 32, 56);
    spot.addColorStop(0, "rgba(255,210,120,0.28)");
    spot.addColorStop(1, "rgba(255,210,120,0)");
    g.fillStyle = spot;
    g.fillRect(x - 56, FEET - 88, 112, 112);
    g.restore();
    drawText(g, "WINNER", x, FEET - 94 + Math.round(Math.sin(now / 300)), "#ffd36a", 2);
    drawText(g, s.names[s.winnerSide], x, FEET - 78, "#f4ead0");
  }
}

function renderFrame(g, sc, s, now) {
  const dt = Math.min(0.05, Math.max(0, (now - sc.last) / 1000));
  sc.last = now;
  const pb = s.playback;

  const gameKey = `${s.matchId}:${pb.gameIndex}`;
  if (gameKey !== sc.gameKey) {
    sc.gameKey = gameKey;
    sc.casings = [];
  }
  const turnKey = `${gameKey}:${pb.turnIndex}`;
  if (turnKey !== sc.turnKey) {
    sc.turnKey = turnKey;
    sc.turnStart = now;
    sc.spawned = new Set();
  }
  const e = now - sc.turnStart;
  const plan = planTurn(s, e);

  sc.shake *= Math.pow(0.02, dt);
  const amp = sc.shake > 0.5 ? Math.round(sc.shake) : 0;
  sc.ox = amp ? Math.round((Math.random() - 0.5) * 2 * amp) : 0;
  sc.oy = amp ? Math.round((Math.random() - 0.5) * 2 * amp) : 0;

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = false;
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  g.fillStyle = "#05070b";
  g.fillRect(0, 0, W, H);
  g.setTransform(1, 0, 0, 1, sc.ox, sc.oy);

  g.drawImage(sc.bg, 0, 0);
  drawLightning(g, sc, now);
  drawLights(g, sc, now);
  drawRain(g, sc, dt, false);
  for (const c of sc.casings) {
    rect(g, c.x, c.y, c.size, 1, c.color);
    if (c.size === 2) rect(g, c.x, c.y, 1, 1, "#f0d58a");
  }

  spawnTurnEffects(sc, plan, e, now);
  [0, 1].forEach((i) => {
    if (s.isBye && i === 1) return;
    drawAgentWorld(g, sc, i, plan.agents[i], now);
  });
  drawDefences(g, plan, e, now);
  drawShots(g, plan, e);
  drawParticles(g, sc, dt);
  drawRain(g, sc, dt, true);
  drawSplashes(g, sc, dt);
  drawFloats(g, sc, now);
  drawOverlays(g, sc, s, plan, e, now);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(sc.vignette, 0, 0);
}

/**
 * props:
 *   playback   - the useDeterministicPlayback() snapshot (turn, game, intermission, completion)
 *   names      - [p1Name, p2Name] shown above the agents
 *   winnerSide - 0 / 1 once the match is decided (used when the match is complete), else null
 *   matchId    - resets the scene between matches
 *   isBye      - a bye shows one agent and no fight
 */
export default function PixelArena({ playback, names, winnerSide, matchId, isBye }) {
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const propsRef = useRef(null);
  propsRef.current = {
    playback,
    names: (names || ["AGENT 001", "AGENT 002"]).map((n) => cleanText(n, 14)),
    winnerSide,
    matchId,
    isBye,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext("2d");
    if (!g) return undefined;
    const sc = createScene();
    if (!SPRITES) loadSprites();
    let raf = null;
    const loop = (now) => {
      try {
        renderFrame(g, sc, propsRef.current, now);
      } catch (err) {
        console.error("PixelArena frame failed:", err);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Scale by a whole number so every art pixel is the same size on the projector.
  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas || typeof ResizeObserver === "undefined") return undefined;
    const fit = () => {
      const k = Math.min(box.clientWidth / W, box.clientHeight / H);
      const scale = k >= 1 ? Math.floor(k) : k;
      canvas.style.width = `${Math.floor(W * scale)}px`;
      canvas.style.height = `${Math.floor(H * scale)}px`;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    fit();
    return () => ro.disconnect();
  }, []);

  return (
    <div className="pixel-arena" ref={boxRef}>
      <canvas ref={canvasRef} width={W} height={H} aria-label="Live duel" />
    </div>
  );
}
