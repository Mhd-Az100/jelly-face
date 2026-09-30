// Jelly Face — page shell and UI (SPEC §7).
// Owns the DOM: boot, sample face, face pipeline (decode → align → texture/thumb/lum → pour),
// controls, pointer interaction on the stage, knife trail, toasts, readouts, theme, main loop,
// and the window.__jellyFace debug hook. Physics lives in physics.js, drawing in render.js.
import { FACE, makeRelief, faceOutline } from './geom.js';
import { World } from './physics.js';
import { createStage } from './render.js';

// ---------------------------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------------------------
const TEX_W = 800, TEX_H = 1000;          // face texture, covers FACE.box (4:5), row 0 = forehead (y1)
const THUMB_W = 64, THUMB_H = 80;         // exported thumbnail
const LUM_W = 100, LUM_H = 125;           // emboss luminance grid
const MAX_SIDE = 2048;                    // decoded photos are limited to this long side
const BOX = FACE.box;
const BOX_W = BOX.x1 - BOX.x0, BOX_H = BOX.y1 - BOX.y0;
const PX = TEX_W / BOX_W;                 // texture px per cm (80)
const LM = FACE.landmarks;
const texX = (x) => ((x - BOX.x0) / BOX_W) * TEX_W;
const texY = (y) => ((BOX.y1 - y) / BOX_H) * TEX_H;

const HINTS = {
  hand: 'Drag the jelly to pull it. Drag the background to turn the view. Tap to poke.',
  knife: 'Swipe all the way across a piece to slice it.',
};
const FLAVOR_NAMES = {
  clear: 'Clear', strawberry: 'Strawberry', lime: 'Lime', blueberry: 'Blueberry', peach: 'Peach', grape: 'Grape',
};
const MSG_BAD_IMAGE = "This image type can't be read here. Try a JPG or PNG.";   // unsupported format (e.g. HEIC)
const MSG_NOT_IMAGE = "That file isn't an image. Try a JPG or PNG.";
// A format the browser reads, but this file would not decode: say so, instead of suggesting the same format.
const msgDamaged = (label) => `This ${label || 'photo'} couldn't be opened. The file may be damaged or incomplete. Try another photo.`;
const MSG_MISS = 'Missed the jelly. Swipe across a piece, starting and ending off it.';
// physics.js words the piece limit around a "Reset" control; the button here is "Pour again".
const MSG_PHYSICS = {
  'That is plenty of pieces. Reset to pour a fresh one.': "That's plenty of pieces. Use Pour again for a fresh jelly.",
};
const MSG_PAUSED_KEYS = 'Paused. Press Space or switch off Pause to see it move.';
const MSG_PAUSED_TOUCH = 'Pause is on. Switch it off to see the nudge.';
const FACE_NOTE = {
  desk: 'JPG, PNG or WebP. Drop or paste an image anywhere on the page.',
  touch: 'JPG, PNG or WebP, from your photos or files.',
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const byId = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
const touchOnly = matchMedia('(hover: none) and (pointer: coarse)');   // phones/tablets with no mouse

// Input modality: which kind of input came last, and which kind moved focus to the current element.
// A control reached with Tab keeps its native Space; one that was merely clicked hands Space to "pause".
const modality = { last: 'pointer', pointerType: touchOnly.matches ? 'touch' : 'mouse', focusFrom: 'pointer' };
function trackModality() {
  document.addEventListener('pointerdown', (e) => {
    modality.last = 'pointer';
    modality.pointerType = e.pointerType || 'mouse';
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) modality.last = 'key';
  }, true);
  document.addEventListener('focusin', () => { modality.focusFrom = modality.last; }, true);
}
// A keyboard hint ("Press Space") only makes sense to someone on a keyboard or using a mouse.
const keyboardLikely = () => modality.last === 'key' || modality.pointerType === 'mouse';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function setText(node, s) {
  if (node && node.textContent !== s) node.textContent = s;
}
function throttle(fn, ms) {
  let last = -Infinity, timer = 0;
  return function run(force = false) {
    const now = performance.now();
    clearTimeout(timer);
    if (force || now - last >= ms) {
      last = now;
      fn();
    } else {
      timer = setTimeout(() => { last = performance.now(); fn(); }, ms - (now - last));
    }
  };
}

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------
const el = {
  frame: byId('stage-frame'), canvas: byId('jelly-canvas'), trail: byId('trail-canvas'),
  fallback: byId('stage-fallback'), toasts: byId('toasts'), actionsToasts: byId('actions-toasts'), dropzone: byId('dropzone'),
  faceNote: byId('face-note'),
  status: byId('stage-status'), recenter: byId('btn-recenter'),
  controls: byId('controls'), file: byId('face-file'),
  choose: byId('btn-choose'), adjust: byId('btn-adjust'), sample: byId('btn-sample'),
  faceKind: byId('face-kind'), thumb: byId('face-thumb'), faceError: byId('face-error'),
  toolHint: byId('tool-hint'), flavorName: byId('flavor-name'),
  firmness: byId('firmness'), damping: byId('damping'), depth: byId('depth'), emboss: byId('emboss'), clarity: byId('clarity'),
  nudge: byId('btn-nudge'), pour: byId('btn-pour'),
  quarter: byId('opt-quarter'), mesh: byId('opt-mesh'), pause: byId('opt-pause'),
  live: byId('live'), liveText: byId('live-text'),
  ro: {
    mass: byId('ro-mass'), volume: byId('ro-volume'), kinetic: byId('ro-kinetic'), pieces: byId('ro-pieces'),
    particles: byId('ro-particles'), tets: byId('ro-tets'),
  },
  dialog: byId('align-dialog'), aView: byId('align-view'), aCanvas: byId('align-canvas'),
  aZoom: byId('align-zoom'), aZoomOut: byId('align-zoom-out'),
  aRotate: byId('align-rotate'), aRotateOut: byId('align-rotate-out'),
  aStatus: byId('align-status'), aReset: byId('align-reset'), aCancel: byId('align-cancel'), aPour: byId('align-pour'),
};
const RANGE_FORMAT = {
  firmness: (v) => `${Math.round(80 + 220 * v)} Bloom`,
  damping: (v) => v.toFixed(2),
  depth: (v) => v.toFixed(2),
  emboss: (v) => v.toFixed(2),
  clarity: (v) => v.toFixed(2),
};

function paintRange(input, text) {
  const min = Number(input.min) || 0, max = Number(input.max) || 1;
  const pct = ((Number(input.value) - min) / (max - min || 1)) * 100;
  input.style.setProperty('--fill', `${clamp(pct, 0, 100).toFixed(2)}%`);
  if (text != null) {
    input.setAttribute('aria-valuetext', text);
    const out = byId(`${input.id}-out`);
    if (out) setText(out, text);
  }
}

// ---------------------------------------------------------------------------------------------
// Core objects
// ---------------------------------------------------------------------------------------------
const world = new World();
let stage = null;

const ui = { tool: 'hand', paused: false, quarter: false, showMesh: false, flavor: 'clear' };

// ---------------------------------------------------------------------------------------------
// Egg outline (texture px) — from geom.faceOutline, ellipse fallback
// ---------------------------------------------------------------------------------------------
let eggCache = null;
function eggPoints() {
  if (eggCache) return eggCache;
  let o = null;
  try {
    if (typeof faceOutline === 'function') o = faceOutline(180);
  } catch (err) {
    o = null;
  }
  if (!o || o.length < 12) {
    const n = 180;
    o = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      o[2 * i] = (FACE.W / 2) * Math.cos(t);
      o[2 * i + 1] = (FACE.H / 2) * Math.sin(t);
    }
  }
  const pts = new Float32Array(o.length);
  for (let i = 0; i < o.length; i += 2) {
    pts[i] = texX(o[i]);
    pts[i + 1] = texY(o[i + 1]);
  }
  eggCache = pts;
  return pts;
}
// Adds the egg to the current path (no beginPath), scaled by k from texture px and shifted by (ox, oy).
function traceEgg(g, k = 1, ox = 0, oy = 0) {
  const p = eggPoints();
  g.moveTo(ox + p[0] * k, oy + p[1] * k);
  for (let i = 2; i < p.length; i += 2) g.lineTo(ox + p[i] * k, oy + p[i + 1] * k);
  g.closePath();
}

// ---------------------------------------------------------------------------------------------
// Sample face: an original illustrated face, positioned from FACE.landmarks
// ---------------------------------------------------------------------------------------------
function drawSampleFace() {
  const c = makeCanvas(TEX_W, TEX_H);
  const g = c.getContext('2d');
  // Work in cm with y up: (x, y) cm → (texX, texY) px.
  g.setTransform(PX, 0, 0, -PX, -BOX.x0 * PX, BOX.y1 * PX);
  const ellipse = (x, y, rx, ry, rot = 0) => { g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); };
  const radial = (x, y, r, inner, outer) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, outer);
    return gr;
  };

  // Skin: warm gradient over the whole box, a little deeper toward the rim.
  let gr = g.createRadialGradient(-0.4, 0.2, 0.4, 0, -0.4, 8.4);
  gr.addColorStop(0, '#f8d6b8');
  gr.addColorStop(0.5, '#f0c19b');
  gr.addColorStop(1, '#d8986f');
  g.fillStyle = gr;
  g.fillRect(BOX.x0, BOX.y0, BOX_W, BOX_H);
  gr = g.createRadialGradient(0, -0.8, 3.4, 0, -0.8, 6.6);
  gr.addColorStop(0, 'rgba(175, 96, 68, 0)');
  gr.addColorStop(1, 'rgba(175, 96, 68, 0.2)');
  g.fillStyle = gr;
  g.fillRect(BOX.x0, BOX.y0, BOX_W, BOX_H);

  // Blush and freckles.
  for (const [cx, cy] of [LM.cheekL, LM.cheekR]) {
    g.fillStyle = radial(cx, cy, 1.4, 'rgba(235, 104, 112, 0.42)', 'rgba(235, 104, 112, 0)');
    g.fillRect(cx - 1.5, cy - 1.5, 3, 3);
  }
  g.fillStyle = 'rgba(160, 92, 62, 0.32)';
  const freckles = [[-0.35, 0.1, 0.05], [-0.62, -0.15, 0.04], [0.4, 0.05, 0.05], [0.7, -0.22, 0.045],
    [-2.1, -0.75, 0.05], [-2.55, -1.0, 0.045], [-1.85, -1.15, 0.04], [2.15, -0.8, 0.05], [2.6, -1.05, 0.045], [1.9, -1.2, 0.04]];
  for (const [x, y, r] of freckles) { ellipse(x, y, r, r * 0.85); g.fill(); }

  // Nose: soft side shadow, tip highlight, nostrils, base line.
  const [, tipY] = LM.noseTip;
  g.lineCap = 'round';
  // light comes from the upper left: the right flank of the nose sits in soft shade
  gr = g.createLinearGradient(0.05, 0, 0.75, 0);
  gr.addColorStop(0, 'rgba(165, 90, 62, 0)');
  gr.addColorStop(0.45, 'rgba(165, 90, 62, 0.16)');
  gr.addColorStop(1, 'rgba(165, 90, 62, 0)');
  g.beginPath();
  g.moveTo(0.12, LM.noseBridge[1] + 0.1);
  g.bezierCurveTo(0.3, -0.3, 0.45, tipY + 0.6, 0.72, tipY + 0.1);
  g.lineTo(0.3, tipY + 0.25);
  g.bezierCurveTo(0.2, tipY + 0.8, 0.08, -0.2, 0.02, LM.noseBridge[1] + 0.1);
  g.closePath();
  g.fillStyle = gr;
  g.fill();
  g.fillStyle = radial(0.05, tipY - 0.3, 0.75, 'rgba(160, 84, 58, 0.2)', 'rgba(160, 84, 58, 0)');
  g.fillRect(-0.8, tipY - 1.1, 1.6, 0.9);
  g.fillStyle = radial(-0.08, tipY + 0.3, 0.32, 'rgba(255, 240, 226, 0.55)', 'rgba(255, 240, 226, 0)');
  g.fillRect(-0.45, tipY - 0.05, 0.75, 0.7);
  for (const s of [-1, 1]) {
    ellipse(s * 0.36, tipY - 0.07, 0.17, 0.075, s * 0.3);
    g.fillStyle = 'rgba(122, 58, 42, 0.5)';
    g.fill();
    g.beginPath();
    g.arc(s * 0.5, tipY + 0.05, 0.24, s > 0 ? -0.2 : Math.PI - 1.4, s > 0 ? 1.4 : Math.PI + 0.2);
    g.lineWidth = 0.05;
    g.strokeStyle = 'rgba(150, 78, 58, 0.3)';
    g.stroke();
  }
  g.beginPath();
  g.moveTo(-0.6, tipY + 0.1);
  g.quadraticCurveTo(0, tipY - 0.36, 0.6, tipY + 0.1);
  g.lineWidth = 0.05;
  g.strokeStyle = 'rgba(150, 78, 58, 0.32)';
  g.stroke();

  // Mouth: a closed smile, lips a little darker than the skin.
  const [, my] = LM.mouth;
  const hw = LM.mouthHalfW;
  const cl = [-hw * 0.94, my + 0.2], cr = [hw * 0.94, my + 0.2];
  g.save();                                        // soft shade under the lower lip
  g.translate(0, my - 0.9);
  g.scale(1, 0.35);
  g.fillStyle = radial(0, 0, 0.9, 'rgba(165, 88, 62, 0.2)', 'rgba(165, 88, 62, 0)');
  g.fillRect(-1, -1, 2, 2);
  g.restore();
  g.beginPath();                                   // upper lip
  g.moveTo(cl[0], cl[1]);
  g.bezierCurveTo(-hw * 0.55, my + 0.34, -0.38, my + 0.5, 0, my + 0.37);
  g.bezierCurveTo(0.38, my + 0.5, hw * 0.55, my + 0.34, cr[0], cr[1]);
  g.quadraticCurveTo(0, my - 0.2, cl[0], cl[1]);
  g.fillStyle = '#bb5d60';
  g.fill();
  g.beginPath();                                   // lower lip
  g.moveTo(cl[0], cl[1]);
  g.quadraticCurveTo(0, my - 0.2, cr[0], cr[1]);
  g.bezierCurveTo(hw * 0.62, my - 0.5, hw * 0.26, my - 0.64, 0, my - 0.62);
  g.bezierCurveTo(-hw * 0.26, my - 0.64, -hw * 0.62, my - 0.5, cl[0], cl[1]);
  g.fillStyle = '#cf7270';
  g.fill();
  ellipse(0.12, my - 0.38, 0.42, 0.09);
  g.fillStyle = 'rgba(255, 222, 212, 0.38)';
  g.fill();
  g.beginPath();                                   // lip line
  g.moveTo(cl[0], cl[1]);
  g.quadraticCurveTo(0, my - 0.2, cr[0], cr[1]);
  g.lineWidth = 0.075;
  g.strokeStyle = '#7e3437';
  g.stroke();
  for (const s of [-1, 1]) {                       // smile creases
    const [x, y] = s < 0 ? cl : cr;
    g.beginPath();
    g.moveTo(x - s * 0.02, y + 0.14);
    g.quadraticCurveTo(x + s * 0.22, y, x + s * 0.02, y - 0.18);
    g.lineWidth = 0.05;
    g.strokeStyle = 'rgba(140, 70, 58, 0.42)';
    g.stroke();
  }
  g.save();                                        // chin highlight
  g.translate(0, LM.chin[1] + 0.55);
  g.scale(1, 0.5);
  g.fillStyle = radial(0, 0, 1.0, 'rgba(255, 236, 220, 0.2)', 'rgba(255, 236, 220, 0)');
  g.fillRect(-1.1, -1.1, 2.2, 2.2);
  g.restore();

  // Eyes and brows.
  const drawEye = (ex, ey, outer) => {
    const w = 0.74, up = 0.42 * 1.35, dn = 0.3 * 1.3;
    const almond = () => {
      g.beginPath();
      g.moveTo(ex - w, ey);
      g.bezierCurveTo(ex - w * 0.55, ey + up, ex + w * 0.55, ey + up, ex + w, ey);
      g.bezierCurveTo(ex + w * 0.5, ey - dn, ex - w * 0.5, ey - dn, ex - w, ey);
      g.closePath();
    };
    g.beginPath();                                 // lid crease
    g.moveTo(ex - w * 0.8, ey + 0.36);
    g.quadraticCurveTo(ex, ey + 0.72, ex + w * 0.85, ey + 0.34);
    g.lineWidth = 0.05;
    g.strokeStyle = 'rgba(140, 78, 55, 0.35)';
    g.stroke();
    g.save();
    almond();
    g.fillStyle = '#fbf6f0';
    g.fill();
    g.clip();
    ellipse(ex + 0.02, ey + 0.05, 0.35, 0.35);
    g.fillStyle = radial(ex + 0.02, ey + 0.05, 0.35, '#94623a', '#4c2b17');
    g.fill();
    ellipse(ex + 0.02, ey + 0.05, 0.155, 0.155);
    g.fillStyle = '#1b120e';
    g.fill();
    ellipse(ex - 0.1, ey + 0.18, 0.075, 0.075);
    g.fillStyle = '#ffffff';
    g.fill();
    ellipse(ex + 0.13, ey - 0.07, 0.035, 0.035);
    g.fillStyle = 'rgba(255, 255, 255, 0.75)';
    g.fill();
    const lid = g.createLinearGradient(0, ey + 0.45, 0, ey + 0.1);
    lid.addColorStop(0, 'rgba(92, 50, 34, 0.4)');
    lid.addColorStop(1, 'rgba(92, 50, 34, 0)');
    g.fillStyle = lid;
    g.fillRect(ex - w, ey - 0.5, 2 * w, 1.1);
    g.restore();
    g.beginPath();                                 // upper lash line
    g.moveTo(ex - w, ey);
    g.bezierCurveTo(ex - w * 0.55, ey + up, ex + w * 0.55, ey + up, ex + w, ey);
    g.lineWidth = 0.1;
    g.strokeStyle = '#3a2117';
    g.stroke();
    g.beginPath();                                 // outer flick
    g.moveTo(ex + outer * w * 0.96, ey + 0.02);
    g.quadraticCurveTo(ex + outer * (w + 0.12), ey + 0.06, ex + outer * (w + 0.2), ey + 0.17);
    g.lineWidth = 0.075;
    g.stroke();
    g.beginPath();                                 // lower lid
    g.moveTo(ex - w * 0.9, ey - 0.03);
    g.bezierCurveTo(ex - w * 0.45, ey - dn, ex + w * 0.45, ey - dn, ex + w * 0.9, ey - 0.03);
    g.lineWidth = 0.04;
    g.strokeStyle = 'rgba(140, 78, 55, 0.3)';
    g.stroke();
  };
  const drawBrow = (ex, outer) => {
    const by = LM.browY;
    const inner = [ex - outer * 0.8, by - 0.06], peak = [ex + outer * 0.2, by + 0.24], tail = [ex + outer * 0.92, by - 0.16];
    g.strokeStyle = '#5b3726';
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(inner[0], inner[1]);
    g.quadraticCurveTo(peak[0], peak[1] + 0.06, tail[0], tail[1]);
    g.lineWidth = 0.17;
    g.stroke();
    g.beginPath();
    g.moveTo(inner[0], inner[1]);
    g.quadraticCurveTo(inner[0] + outer * 0.45, by + 0.2, peak[0], peak[1]);
    g.lineWidth = 0.27;
    g.stroke();
  };
  drawEye(LM.eyeL[0], LM.eyeL[1], -1);
  drawEye(LM.eyeR[0], LM.eyeR[1], 1);
  drawBrow(LM.eyeL[0], -1);
  drawBrow(LM.eyeR[0], 1);

  // Hair: a soft cap across the top with a side part on the viewer's left.
  const partX = -1.2;
  const hairPath = () => {
    g.beginPath();
    g.moveTo(-5.4, 0.3);
    g.lineTo(-5.4, 6.6);
    g.lineTo(5.4, 6.6);
    g.lineTo(5.4, 0.8);
    g.bezierCurveTo(5.05, 2.35, 4.35, 3.0, 3.2, 3.2);
    g.bezierCurveTo(1.6, 3.45, 0.05, 3.5, partX + 0.2, 4.05);
    g.lineTo(partX - 0.05, 4.35);
    g.bezierCurveTo(-2.1, 3.9, -3.3, 3.55, -4.1, 2.7);
    g.bezierCurveTo(-4.7, 2.05, -5.1, 1.2, -5.4, 0.3);
    g.closePath();
  };
  gr = g.createLinearGradient(0, 6.5, 0, 1.0);
  gr.addColorStop(0, '#34201a');
  gr.addColorStop(1, '#5c3a28');
  g.save();
  g.shadowColor = 'rgba(110, 56, 36, 0.35)';
  g.shadowBlur = 26;
  g.shadowOffsetY = 12;
  hairPath();
  g.fillStyle = gr;
  g.fill();
  g.restore();
  g.save();
  hairPath();
  g.clip();
  g.fillStyle = radial(1.9, 5.1, 2.8, 'rgba(255, 214, 180, 0.16)', 'rgba(255, 214, 180, 0)');
  g.fillRect(-1, 2.2, 6, 6);
  g.lineCap = 'round';
  g.lineWidth = 0.06;
  g.strokeStyle = 'rgba(150, 102, 74, 0.34)';
  for (let i = 0; i < 7; i++) {                     // strands sweeping right from the part
    const t = i / 6;
    g.beginPath();
    g.moveTo(partX + 0.15 + t * 0.3, 4.5 + t * 1.6);
    g.bezierCurveTo(0.8 + t, 5.8 - t * 0.3, 3.4 + t * 0.4, 4.6 - t * 0.2, 5.0, 1.6 + t * 2.6);
    g.stroke();
  }
  for (let i = 0; i < 5; i++) {                     // strands falling left
    const t = i / 4;
    g.beginPath();
    g.moveTo(partX - 0.15 - t * 0.2, 4.6 + t * 1.5);
    g.bezierCurveTo(-2.6 - t * 0.4, 5.2 - t * 0.2, -4.2, 4.2, -5.0, 1.2 + t * 2.4);
    g.stroke();
  }
  g.beginPath();                                    // the part itself
  g.moveTo(partX - 0.05, 4.35);
  g.quadraticCurveTo(partX + 0.1, 5.5, partX + 0.45, 6.6);
  g.lineWidth = 0.05;
  g.strokeStyle = 'rgba(24, 12, 8, 0.55)';
  g.stroke();
  g.restore();

  g.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------------------------
// Face pipeline helpers: thumbnail, emboss luminance, mean color
// ---------------------------------------------------------------------------------------------
function makeThumb(tex, w = THUMB_W, h = THUMB_H) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.save();
  g.beginPath();
  traceEgg(g, w / TEX_W);
  g.clip();
  g.drawImage(tex, 0, 0, w, h);
  g.restore();
  return c;
}

function computeLum(tex) {
  // Two-step downsample (800×1000 → 200×250 → 100×125) to limit aliasing.
  const mid = makeCanvas(LUM_W * 2, LUM_H * 2);
  const gm = mid.getContext('2d');
  gm.imageSmoothingQuality = 'high';
  gm.drawImage(tex, 0, 0, mid.width, mid.height);
  const small = makeCanvas(LUM_W, LUM_H);
  const gs = small.getContext('2d', { willReadFrequently: true });
  gs.imageSmoothingQuality = 'high';
  gs.drawImage(mid, 0, 0, LUM_W, LUM_H);
  const px = gs.getImageData(0, 0, LUM_W, LUM_H).data;
  const n = LUM_W * LUM_H;
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]) / 255;
  const R = 2, span = 2 * R + 1;
  for (let y = 0; y < LUM_H; y++) {                   // horizontal box blur, clamped edges
    for (let x = 0; x < LUM_W; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += a[y * LUM_W + clamp(x + k, 0, LUM_W - 1)];
      b[y * LUM_W + x] = s / span;
    }
  }
  for (let y = 0; y < LUM_H; y++) {                   // vertical box blur
    for (let x = 0; x < LUM_W; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += b[clamp(y + k, 0, LUM_H - 1) * LUM_W + x];
      a[y * LUM_W + x] = s / span;
    }
  }
  return { w: LUM_W, h: LUM_H, data: a };
}

function meanColor(src) {
  const c = makeCanvas(16, 16);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let r = 0, gg = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    r += d[i] * a; gg += d[i + 1] * a; b += d[i + 2] * a; w += a;
  }
  if (w < 1e-3) return 'rgb(200, 180, 165)';
  return `rgb(${Math.round(r / w)}, ${Math.round(gg / w)}, ${Math.round(b / w)})`;
}

// ---------------------------------------------------------------------------------------------
// Current face + relief
// ---------------------------------------------------------------------------------------------
const face = {
  kind: 'sample',     // 'sample' | 'photo'
  texture: null,      // 800×1000 canvas
  thumb: null,        // 64×80 canvas (egg-masked)
  lum: null,          // { w, h, data } for makeRelief
  photo: null,        // { src, mean, transform, initial } for "Adjust fit"
  serial: 0,
};
let reliefCache = null;   // { key, fn }
let appliedReliefKey = '';

function currentRelief() {
  const depth = Number(el.depth.value), emboss = Number(el.emboss.value);
  const key = `${face.serial}|${depth}|${emboss}`;
  if (!reliefCache || reliefCache.key !== key) {
    reliefCache = { key, fn: makeRelief({ depth, emboss, lum: face.lum }) };
  }
  return reliefCache;
}

function setFace(texture, kind, photo = null) {
  face.texture = texture;
  face.kind = kind;
  face.photo = photo;
  face.lum = computeLum(texture);
  face.thumb = makeThumb(texture);
  face.serial++;
  drawThumb();
  setText(el.faceKind, kind === 'photo' ? 'Your photo' : 'Sample face');
  el.adjust.disabled = !stage || kind !== 'photo';
  if (stage) stage.setFaceTexture(texture);
}

function drawThumb() {
  const c = el.thumb, g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  if (!face.texture) return;
  const k = c.width / TEX_W;
  g.save();
  g.beginPath();
  traceEgg(g, k);
  g.clip();
  g.imageSmoothingQuality = 'high';
  g.drawImage(face.texture, 0, 0, c.width, c.height);
  g.restore();
  g.beginPath();
  traceEgg(g, k);
  g.lineWidth = 1.5;
  g.strokeStyle = theme.lineStrong || 'rgba(21, 24, 28, 0.36)';
  g.stroke();
}

function pour() {
  if (!stage) return;
  const r = currentRelief();
  world.pour(r.fn, { lift: reducedMotion.matches ? 0.3 : 5 });
  appliedReliefKey = r.key;
}

function remoldNow() {
  if (!stage) return;
  const r = currentRelief();
  if (r.key === appliedReliefKey) return;
  appliedReliefKey = r.key;
  world.remold(r.fn);
}
const remoldThrottled = throttle(remoldNow, 250);   // ≤ 4 per second while dragging

function pourSample() {
  setFace(drawSampleFace(), 'sample');
  hideFaceError();
  pour();
}

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------
let theme = { isDark: false, bg: '#DADFE3', floor: '#CBD2D8', ink: '#15181C', accent: '#B3214D', lineStrong: '' };

function colorLuma(str) {
  const s = String(str || '').trim();
  let r, g, b;
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else if ((m = s.match(/rgba?\(([^)]+)\)/i))) {
    [r, g, b] = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  } else {
    return null;
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const paper = get('--paper', '#E7EAEC');
  const luma = colorLuma(paper);
  const attr = document.documentElement.getAttribute('data-theme');
  const isDark = luma != null ? luma < 0.4 : (attr === 'dark' || (attr !== 'light' && darkScheme.matches));
  return {
    isDark,
    bg: get('--stage-bg', '#DADFE3'),
    floor: get('--stage-floor', '#CBD2D8'),
    ink: get('--ink', '#15181C'),
    accent: get('--accent', '#B3214D'),
    lineStrong: get('--line-strong', 'rgba(21, 24, 28, 0.36)'),
  };
}

function applyTheme() {
  const t = readTheme();
  const changed = !theme || ['isDark', 'bg', 'floor', 'ink', 'accent', 'lineStrong'].some((k) => theme[k] !== t[k]);
  theme = t;
  if (!changed) return;
  if (stage) {
    try {
      stage.setTheme({ isDark: t.isDark, bg: t.bg, floor: t.floor, ink: t.ink, accent: t.accent });
    } catch (err) {
      console.error('[jelly-face] setTheme failed', err);
    }
  }
  drawThumb();
  trailDirty = true;
  if (el.dialog.open) requestAlignDraw();
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------
// toast(message, ms) or toast(message, { ms, host, silent }). `host` is a toast area (the stage's by default);
// `silent` hides the toast from assistive tech when the same words are already announced elsewhere.
function toast(message, opts = {}) {
  if (!message) return;
  const { ms = 3400, host = el.toasts, silent = false } = typeof opts === 'number' ? { ms: opts } : opts;
  const last = host.lastElementChild;
  if (last && last.textContent === message && !last.classList.contains('out')) {
    clearTimeout(last._timer);
    last._timer = setTimeout(() => dismissToast(last), ms);
    return;
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  if (silent) t.setAttribute('aria-hidden', 'true');
  host.append(t);
  while (host.children.length > 2) host.firstElementChild.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('in')));
  t._timer = setTimeout(() => dismissToast(t), ms);
}
function dismissToast(t) {
  t.classList.remove('in');
  t.classList.add('out');
  setTimeout(() => t.remove(), reducedMotion.matches ? 0 : 300);
}
// Is the vertical band [top, bottom] (client px) on screen?
function bandInView(top, bottom) {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return bottom > 0 && top < vh;
}
// The stage toasts sit in the bottom ~60px of the stage frame.
function stageToastsInView() {
  const r = el.frame.getBoundingClientRect();
  return r.height > 0 && bandInView(r.bottom - 64, r.bottom - 16);
}
// A hint caused by a panel control: shown on the stage when it is on screen, otherwise right above `nearHost`
// (e.g. on a phone, where the Actions buttons sit far below the stage).
function hint(message, nearHost) {
  if (nearHost && !stageToastsInView()) {
    const r = nearHost.parentElement.getBoundingClientRect();
    if (bandInView(r.top - 60, r.bottom)) {
      toast(message, { host: nearHost, ms: 4200 });
      return;
    }
  }
  toast(message);
}

function showFaceError(msg) {
  el.faceError.textContent = msg;
  el.faceError.hidden = false;
}
// The inline error (role=alert) announces itself; the toast is a visual pointer only for when the Face
// section is off screen (e.g. a photo dropped onto the stage on a phone), so it is hidden from screen readers.
function reportFaceError(msg) {
  showFaceError(msg);
  const r = el.faceError.getBoundingClientRect();
  if (!(r.height > 0 && bandInView(r.top, r.bottom))) toast(msg, { silent: true });
}
function hideFaceError() {
  el.faceError.hidden = true;
  el.faceError.textContent = '';
}

// ---------------------------------------------------------------------------------------------
// Tools, switches, actions
// ---------------------------------------------------------------------------------------------
function setTool(name) {
  if (name !== 'hand' && name !== 'knife') return false;
  if (ui.tool !== name) cancelGesture();
  ui.tool = name;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === name));
  setText(el.toolHint, HINTS[name]);
  el.frame.classList.toggle('is-knife', name === 'knife');
  return true;
}

function setPaused(on) {
  ui.paused = !!on;
  el.pause.checked = ui.paused;
  updateStatus();
  if (!ui.paused) {   // a "Pause is on" hint is out of date once it is off
    for (const t of [...el.toasts.children, ...el.actionsToasts.children]) {
      if (t.textContent === MSG_PAUSED_KEYS || t.textContent === MSG_PAUSED_TOUCH) { clearTimeout(t._timer); dismissToast(t); }
    }
  }
}
function setQuarter(on) {
  ui.quarter = !!on;
  el.quarter.checked = ui.quarter;
  updateStatus();
}
function setShowMesh(on) {
  ui.showMesh = !!on;
  el.mesh.checked = ui.showMesh;
  if (stage) stage.setShowMesh(ui.showMesh);
}
function setFlavor(key) {
  if (!FLAVOR_NAMES[key]) return;
  ui.flavor = key;
  const radio = byId(`flavor-${key}`);
  if (radio && !radio.checked) radio.checked = true;
  setText(el.flavorName, FLAVOR_NAMES[key]);
  if (stage) stage.setFlavor(key);
}
function nudge() {
  if (!stage) return;
  world.nudge();
  if (ui.paused) hint(keyboardLikely() ? MSG_PAUSED_KEYS : MSG_PAUSED_TOUCH, el.actionsToasts);
}
function pourAgain() {
  if (!stage) return;
  pour();
}

function updateStatus() {
  const running = !!stage && !ui.paused && !document.hidden;
  el.live.classList.toggle('is-idle', !running);
  setText(el.liveText, !stage ? 'Off' : ui.paused ? 'Paused' : 'Live');
  const parts = [];
  if (ui.paused) parts.push('Paused');
  if (ui.quarter) parts.push('¼ speed');
  el.status.hidden = parts.length === 0;
  setText(el.status, parts.join(' · '));
}

function wireControls() {
  for (const id of ['firmness', 'damping', 'depth', 'emboss', 'clarity']) {
    const input = el[id];
    const onInput = () => {
      const v = Number(input.value);
      paintRange(input, RANGE_FORMAT[id](v));
      if (id === 'firmness') world.params.firmness = v;
      else if (id === 'damping') world.params.damping = v;
      else if (id === 'clarity') { if (stage) stage.setClarity(v); }
      else remoldThrottled();
    };
    input.addEventListener('input', onInput);
    if (id === 'depth' || id === 'emboss') input.addEventListener('change', () => remoldThrottled(true));
  }
  for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  for (const r of document.querySelectorAll('input[name="flavor"]')) {
    r.addEventListener('change', () => { if (r.checked) setFlavor(r.value); });
  }
  el.quarter.addEventListener('change', () => setQuarter(el.quarter.checked));
  el.mesh.addEventListener('change', () => setShowMesh(el.mesh.checked));
  el.pause.addEventListener('change', () => setPaused(el.pause.checked));
  el.nudge.addEventListener('click', nudge);
  el.pour.addEventListener('click', pourAgain);
  el.recenter.addEventListener('click', () => { if (stage) stage.resetView(); });
  el.choose.addEventListener('click', () => el.file.click());
  el.adjust.addEventListener('click', () => {
    if (face.kind === 'photo' && face.photo) openAlign(face.photo.src, face.photo);
  });
  el.sample.addEventListener('click', () => { if (stage) pourSample(); });
  el.file.addEventListener('change', () => {
    const f = el.file.files && el.file.files[0];
    el.file.value = '';
    if (f) loadFile(f);
  });
}

// Apply the current DOM control values (the host may restore form state across republishes).
function syncFromControls() {
  const f = Number(el.firmness.value), d = Number(el.damping.value), c = Number(el.clarity.value);
  world.params.firmness = f;
  world.params.damping = d;
  for (const id of ['firmness', 'damping', 'depth', 'emboss', 'clarity']) paintRange(el[id], RANGE_FORMAT[id](Number(el[id].value)));
  const checked = document.querySelector('input[name="flavor"]:checked');
  setFlavor(checked ? checked.value : 'clear');
  if (stage) stage.setClarity(c);
  setShowMesh(el.mesh.checked);
  setQuarter(el.quarter.checked);
  setPaused(el.pause.checked);
}

function disableControls() {
  el.controls.classList.add('is-disabled');
  for (const n of document.querySelectorAll('#controls button, #controls input, .stage-tools button, #btn-recenter')) n.disabled = true;
}

// ---------------------------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------------------------
const liveCountNodes = {
  particles: Array.from(document.querySelectorAll('[data-live="particles"]')),
  tets: Array.from(document.querySelectorAll('[data-live="tets"]')),
};
const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
const fmtFixed = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '–');
function fmtEnergy(v) {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  return a < 10 ? v.toFixed(2) : a < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US');
}
function updateReadouts() {
  let m = null;
  try { m = world.metrics(); } catch (err) { m = null; }
  if (!m) return;
  setText(el.ro.mass, fmtFixed(m.massG, 1));
  setText(el.ro.volume, fmtFixed(m.volumePct, 1));
  setText(el.ro.kinetic, fmtEnergy(m.kineticUJ));
  setText(el.ro.pieces, fmtInt(m.pieces));
  const p = fmtInt(m.particles), t = fmtInt(m.tets);
  setText(el.ro.particles, p);
  setText(el.ro.tets, t);
  for (const n of liveCountNodes.particles) setText(n, p);
  for (const n of liveCountNodes.tets) setText(n, t);
}

// ---------------------------------------------------------------------------------------------
// Stage sizing
// ---------------------------------------------------------------------------------------------
// Moving the window to a display with another pixel ratio changes neither the CSS size nor fires 'resize', so
// the frame loop also re-fits when devicePixelRatio differs from the ratio of the last fit.
let fittedDpr = 0;
function fitStage() {
  const w = Math.max(1, el.frame.clientWidth), h = Math.max(1, el.frame.clientHeight);
  const dpr = window.devicePixelRatio || 1;
  fittedDpr = dpr;
  if (stage) {
    try { stage.resize(w, h, dpr); } catch (err) { console.error('[jelly-face] resize failed', err); }
  }
  const tdpr = Math.min(dpr, 2);
  const tw = Math.round(w * tdpr), th = Math.round(h * tdpr);
  if (el.trail.width !== tw || el.trail.height !== th) {
    el.trail.width = tw;
    el.trail.height = th;
    trailDirty = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Pointer interaction on the stage
// ---------------------------------------------------------------------------------------------
const ptrs = new Map();       // pointerId → { x, y }
let gesture = null;           // { type: 'grab' | 'orbit' | 'knife' | 'pinch', ... }
let trail = null;             // { pts: [[x, y], ...] client px, fadeStart }
let trailDirty = false;
const TRAIL_FADE_MS = 480;

function ndcOf(x, y) {
  const r = el.canvas.getBoundingClientRect();
  return [((x - r.left) / (r.width || 1)) * 2 - 1, 1 - ((y - r.top) / (r.height || 1)) * 2];
}
const orbitScale = () => Math.PI / Math.max(200, el.canvas.clientHeight || 500);

function grabTarget(x, y, plane) {
  const [nx, ny] = ndcOf(x, y);
  const { origin: o, dir: d } = stage.ray(nx, ny);
  const n = plane.n;
  const den = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((plane.p[0] - o[0]) * n[0] + (plane.p[1] - o[1]) * n[1] + (plane.p[2] - o[2]) * n[2]) / den;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return [o[0] + t * d[0], Math.max(0.2, o[1] + t * d[1]), o[2] + t * d[2]];
}

function endGrabGesture() {
  world.endGrab();
  el.frame.classList.remove('is-grabbing');
}

function cancelGesture() {
  if (!gesture) return;
  if (gesture.type === 'grab') endGrabGesture();
  if (gesture.type === 'knife' && trail) trail.fadeStart = performance.now();
  gesture = null;
}

function onStageDown(e) {
  if (!stage) return;
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
  e.preventDefault();
  // preventDefault also stops the press from moving focus, which would leave it on the last clicked button
  // (Space would press that button again). Take focus here; the class keeps the ring for keyboard focus only.
  el.canvas.classList.add('is-pointer-focus');
  if (document.activeElement !== el.canvas) el.canvas.focus({ preventScroll: true });
  try { el.canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1 && gesture) cancelGesture();   // a stale gesture whose pointerup never arrived
  if (ptrs.size === 2) {
    cancelGesture();
    const [a, b] = [...ptrs.values()];
    gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    return;
  }
  if (ptrs.size > 2 || gesture) return;
  const base = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), moved: 0 };
  if (e.button === 2) {
    gesture = { type: 'orbit', ...base };
    return;
  }
  if (ui.tool === 'knife') {
    gesture = { type: 'knife', ...base, pts: [[e.clientX, e.clientY]] };
    trail = { pts: gesture.pts, fadeStart: 0 };
    trailDirty = true;
    return;
  }
  const [nx, ny] = ndcOf(e.clientX, e.clientY);
  const hit = stage.pick(nx, ny);
  if (hit && world.beginGrab(hit.body, hit.point)) {
    gesture = { type: 'grab', ...base, hit, plane: { p: hit.point.slice(0, 3), n: stage.viewDir() } };
    el.frame.classList.add('is-grabbing');
  } else {
    gesture = { type: 'orbit', ...base };
  }
}

function onStageMove(e) {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    if (ptrs.size < 2) return;
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (gesture.d > 4 && d > 4) stage.zoom(d / gesture.d);
    const k = orbitScale();
    stage.orbit(-(mx - gesture.mx) * k, (my - gesture.my) * k);
    Object.assign(gesture, { d, mx, my });
    return;
  }
  if (gesture.id !== e.pointerId) return;
  gesture.moved = Math.max(gesture.moved, Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y));
  if (gesture.type === 'grab') {
    const target = grabTarget(e.clientX, e.clientY, gesture.plane);
    if (target) world.moveGrab(target);
  } else if (gesture.type === 'orbit') {
    const k = orbitScale();
    stage.orbit(-(e.clientX - gesture.lx) * k, (e.clientY - gesture.ly) * k);
  } else if (gesture.type === 'knife') {
    const last = gesture.pts[gesture.pts.length - 1];
    if (Math.hypot(e.clientX - last[0], e.clientY - last[1]) >= 2) {
      gesture.pts.push([e.clientX, e.clientY]);
      trailDirty = true;
    }
  }
  gesture.lx = e.clientX;
  gesture.ly = e.clientY;
}

function onStageUp(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  try { el.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    if (ptrs.size === 0) gesture = null;   // the remaining finger does not start a new gesture
    return;
  }
  if (gesture.id !== e.pointerId) return;
  const g = gesture;
  gesture = null;
  const committed = e.type === 'pointerup';
  if (g.type === 'grab') {
    endGrabGesture();
    if (committed && g.moved < 6 && performance.now() - g.t < 280) {
      const n = g.hit.normal || stage.viewDir().map((v) => -v);
      world.poke(g.hit.body, g.hit.point, [-n[0], -n[1], -n[2]]);
    }
  } else if (g.type === 'knife') {
    if (trail) trail.fadeStart = performance.now();
    const a = g.pts[0], b = g.pts[g.pts.length - 1];
    if (committed && Math.hypot(b[0] - a[0], b[1] - a[1]) >= 24) sliceClient(a, b);
  }
}

function sliceClient(a, b) {
  const A = ndcOf(a[0], a[1]), B = ndcOf(b[0], b[1]);
  const plane = stage.bladePlane(A, B);
  const r = world.slice(plane, plane.accept) || { cut: 0, pieces: world.bodies.length, message: '' };
  // physics returns '' both on success and on a clean miss; only a miss gets the hint
  if (r.message) toast(MSG_PHYSICS[r.message] || r.message);
  else if (!r.cut) toast(MSG_MISS);
  else for (const t of Array.from(el.toasts.children)) { clearTimeout(t._timer); dismissToast(t); }   // a stale hint would contradict the cut
  try { stage.flashCut(A, B); } catch (err) { /* optional */ }
  return r;
}

function onStageWheel(e) {
  if (!stage) return;
  e.preventDefault();
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;
  else if (e.deltaMode === 2) dy *= 400;
  const rate = e.ctrlKey ? 0.01 : 0.0015;          // trackpad pinch arrives as ctrl+wheel
  stage.zoom(Math.exp(-clamp(dy, -240, 240) * rate));
}

function drawTrail(now) {
  if (!trail && !trailDirty) return;
  const c = el.trail, g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  trailDirty = false;
  if (!trail || trail.pts.length === 0) { trail = null; return; }
  let alpha = 1;
  if (trail.fadeStart) {
    alpha = Math.min(1, 1 - (now - trail.fadeStart) / TRAIL_FADE_MS);
    if (alpha <= 0) { trail = null; return; }
  }
  const r = c.getBoundingClientRect();
  const s = c.width / (r.width || 1);
  g.setTransform(s, 0, 0, s, -r.left * s, -r.top * s);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const pts = trail.pts;
  const a = pts[0], b = pts[pts.length - 1];
  g.globalAlpha = alpha * 0.55;                      // the straight blade that will actually cut
  g.setLineDash([5, 7]);
  g.lineWidth = 1.25;
  g.strokeStyle = theme.accent;
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.stroke();
  g.setLineDash([]);
  g.globalAlpha = alpha;                             // the stroke itself, thickening toward the tip
  const n = pts.length;
  for (let i = 1; i < n; i++) {
    g.lineWidth = 1 + 3.5 * (i / n);
    g.beginPath();
    g.moveTo(pts[i - 1][0], pts[i - 1][1]);
    g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
  }
  g.beginPath();
  g.arc(b[0], b[1], 3.2, 0, Math.PI * 2);
  g.fillStyle = theme.accent;
  g.fill();
  g.globalAlpha = 1;
}

function wireStage() {
  el.canvas.addEventListener('pointerdown', onStageDown);
  el.canvas.addEventListener('pointermove', onStageMove);
  el.canvas.addEventListener('pointerup', onStageUp);
  el.canvas.addEventListener('pointercancel', onStageUp);
  el.canvas.addEventListener('lostpointercapture', (e) => { if (ptrs.has(e.pointerId)) onStageUp(e); });
  el.canvas.addEventListener('wheel', onStageWheel, { passive: false });
  el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  el.canvas.addEventListener('blur', () => el.canvas.classList.remove('is-pointer-focus'));
}

// ---------------------------------------------------------------------------------------------
// Photo decoding + drag/drop/paste
// ---------------------------------------------------------------------------------------------
async function decodeImage(file) {
  let img = null;
  if (typeof createImageBitmap === 'function') {
    try { img = await createImageBitmap(file); } catch (err) { img = null; }
  }
  if (!img) {
    img = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      im.src = url;
    });
  }
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('decode');
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = makeCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  if (typeof img.close === 'function') img.close();
  return c;
}

// What the file's first bytes say it is (the name and MIME type can lie): a format label, or '' if unknown.
const WEB_FORMATS = { jpeg: 'JPG', png: 'PNG', gif: 'GIF', webp: 'WebP', bmp: 'BMP' };   // every browser decodes these
async function sniffFormat(file) {
  let b;
  try { b = new Uint8Array(await file.slice(0, 16).arrayBuffer()); } catch (err) { return ''; }
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(4, 4) === 'ftyp') return /^avi[fs]/.test(ascii(8, 4)) ? 'avif' : 'heif';
  return '';
}
// Why a file that claims to be an image did not decode: a damaged photo in a format the browser reads, or a
// format it can't read (HEIC in most browsers, TIFF, RAW, ...).
async function decodeFailureMessage(file) {
  const kind = await sniffFormat(file);
  if (WEB_FORMATS[kind]) return msgDamaged(WEB_FORMATS[kind]);
  const claimed = (/^image\/(jpeg|jpg|pjpeg|png|gif|webp|bmp)$/.exec((file.type || '').toLowerCase()) || [])[1];
  if (!kind && claimed) return msgDamaged(WEB_FORMATS[claimed === 'jpg' || claimed === 'pjpeg' ? 'jpeg' : claimed]);
  return MSG_BAD_IMAGE;
}

let loadSerial = 0;
async function loadFile(file) {
  if (!stage || !file) return false;
  hideFaceError();
  if (file.type && !file.type.startsWith('image/')) {
    reportFaceError(MSG_NOT_IMAGE);
    return false;
  }
  const serial = ++loadSerial;
  let src;
  try {
    src = await decodeImage(file);
  } catch (err) {
    const msg = await decodeFailureMessage(file);
    if (serial === loadSerial) reportFaceError(msg);
    return false;
  }
  if (serial !== loadSerial) return false;
  openAlign(src, null);
  return true;
}

function firstImageFile(list) {
  const files = Array.from(list || []);
  return files.find((f) => f.type && f.type.startsWith('image/')) || files[0] || null;
}

function wireFileSources() {
  let depth = 0;
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  const show = (on) => { el.dropzone.hidden = !on || !stage; };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = stage ? 'copy' : 'none';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    const f = firstImageFile(e.dataTransfer.files);
    if (f) loadFile(f);
  });
  document.addEventListener('paste', (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const item = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!item) return;
    const f = item.getAsFile();
    if (!f) return;
    e.preventDefault();
    loadFile(f);
  });
}

// ---------------------------------------------------------------------------------------------
// Align dialog
// ---------------------------------------------------------------------------------------------
// Transform: an image pixel (u, v) lands at texture px  T + R(rot) · (s · ((u, v) − center)),
// with s = s0 · zoom and s0 = cover-fit of the whole 800×1000 box. No mirroring.
const align = {
  src: null, iw: 0, ih: 0, mean: 'rgb(200, 180, 165)', s0: 1,
  zoom: 1, rot: 0, tx: TEX_W / 2, ty: TEX_H / 2,
  initial: null, touched: false, token: 0,
  ptrs: new Map(), gest: null, raf: 0,
};
const coverFit = () => ({ zoom: 1, rot: 0, tx: TEX_W / 2, ty: TEX_H / 2 });
const pickFit = (o) => ({ zoom: o.zoom, rot: o.rot, tx: o.tx, ty: o.ty });

function openAlign(src, photo) {
  align.token++;
  const token = align.token;
  align.src = src;
  align.iw = src.width;
  align.ih = src.height;
  align.mean = photo ? photo.mean : meanColor(src);
  align.s0 = Math.max(TEX_W / align.iw, TEX_H / align.ih);
  align.initial = photo && photo.initial ? pickFit(photo.initial) : coverFit();
  Object.assign(align, photo && photo.transform ? pickFit(photo.transform) : align.initial);
  align.touched = false;
  align.ptrs.clear();
  align.gest = null;
  setText(el.aStatus, '');
  syncAlignInputs();
  if (!el.dialog.open) el.dialog.showModal();
  sizeAlignCanvas();
  requestAlignDraw();
  if (!photo) {
    detectFace(src).then((det) => {
      if (token !== align.token || !det || !el.dialog.open) return;
      const fit = fitFromDetection(det);
      if (!fit) return;
      align.initial = fit;
      if (align.touched) return;
      Object.assign(align, fit);
      syncAlignInputs();
      requestAlignDraw();
      setText(el.aStatus, 'Lined up from the face it found. Adjust if needed.');
    });
  }
}

async function detectFace(src) {
  if (!('FaceDetector' in window)) return null;
  try {
    const fd = new window.FaceDetector({ fastMode: false, maxDetectedFaces: 1 });
    const faces = await fd.detect(src);
    const f = faces && faces[0];
    if (!f) return null;
    const eyes = (f.landmarks || [])
      .filter((l) => l.type === 'eye' && l.locations && l.locations.length)
      .map((l) => {
        let x = 0, y = 0;
        for (const p of l.locations) { x += p.x; y += p.y; }
        return { x: x / l.locations.length, y: y / l.locations.length };
      })
      .sort((a, b) => a.x - b.x);
    return { box: f.boundingBox || null, eyes: eyes.length >= 2 ? [eyes[0], eyes[eyes.length - 1]] : null };
  } catch (err) {
    return null;
  }
}

function fitFromDetection(det) {
  const cx = align.iw / 2, cy = align.ih / 2;
  if (det.eyes) {
    const [a, b] = det.eyes;
    const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
    if (dist < 4) return null;
    const guide = (LM.eyeR[0] - LM.eyeL[0]) * PX;
    const zoom = clamp(guide / dist / align.s0, 1, 6);
    const rot = clamp((-Math.atan2(dy, dx) * 180) / Math.PI, -30, 30);
    const s = align.s0 * zoom, th = (rot * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th);
    const mx = (a.x + b.x) / 2 - cx, my = (a.y + b.y) / 2 - cy;
    const gx = texX((LM.eyeL[0] + LM.eyeR[0]) / 2), gy = texY((LM.eyeL[1] + LM.eyeR[1]) / 2);
    return { zoom, rot, tx: gx - s * (c * mx - sn * my), ty: gy - s * (sn * mx + c * my) };
  }
  if (det.box && det.box.width > 4) {
    const bx = det.box.x + det.box.width / 2 - cx, by = det.box.y + det.box.height / 2 - cy;
    const zoom = clamp((8 * PX) / det.box.width / align.s0, 1, 6);
    const s = align.s0 * zoom;
    return { zoom, rot: 0, tx: texX(0) - s * bx, ty: texY(-1.2) - s * by };
  }
  return null;
}

function clampAlign() {
  align.tx = clamp(align.tx, -TEX_W, 2 * TEX_W);
  align.ty = clamp(align.ty, -TEX_H, 2 * TEX_H);
}
function zoomAbout(px, py, z) {
  z = clamp(z, 1, 6);
  const f = z / align.zoom;
  align.tx = px + (align.tx - px) * f;
  align.ty = py + (align.ty - py) * f;
  align.zoom = z;
  clampAlign();
}
function rotateAbout(px, py, deg) {
  deg = clamp(deg, -30, 30);
  const d = ((deg - align.rot) * Math.PI) / 180, c = Math.cos(d), s = Math.sin(d);
  const x = align.tx - px, y = align.ty - py;
  align.tx = px + c * x - s * y;
  align.ty = py + s * x + c * y;
  align.rot = deg;
  clampAlign();
}
function syncAlignInputs() {
  el.aZoom.value = String(align.zoom);
  el.aRotate.value = String(align.rot);
  const z = `${align.zoom.toFixed(2)}×`;
  const r = `${align.rot < 0 ? '−' : ''}${Math.abs(align.rot).toFixed(align.rot % 1 ? 1 : 0)}°`;
  paintRange(el.aZoom, z);
  paintRange(el.aRotate, r);
}
function alignChanged() {
  align.touched = true;
  syncAlignInputs();
  requestAlignDraw();
}
// Where the 800×1000 texture box sits inside a W×H area: uniform scale k, centered. The view is 4:5 by CSS,
// but drawing and pointer mapping both go through this, so a view that is off by a few px can never mis-map.
function fitBox(W, H) {
  const k = Math.min(W / TEX_W, H / TEX_H) || 1;
  return { k, ox: (W - TEX_W * k) / 2, oy: (H - TEX_H * k) / 2 };
}
function alignCssBox() {
  const r = el.aCanvas.getBoundingClientRect();
  const b = fitBox(r.width || 1, r.height || 1);
  return { k: b.k, x0: r.left + b.ox, y0: r.top + b.oy };
}
function clientToTex(x, y) {
  const b = alignCssBox();
  return [(x - b.x0) / b.k, (y - b.y0) / b.k];
}

function applyAlignTransform(g, k, ox = 0, oy = 0) {
  g.setTransform(k, 0, 0, k, ox, oy);
  g.translate(align.tx, align.ty);
  g.rotate((align.rot * Math.PI) / 180);
  const s = align.s0 * align.zoom;
  g.scale(s, s);
}

function sizeAlignCanvas() {
  const w = el.aView.clientWidth, h = el.aView.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
  if (el.aCanvas.width !== cw || el.aCanvas.height !== ch) {
    el.aCanvas.width = cw;
    el.aCanvas.height = ch;
  }
  requestAlignDraw();
}
function requestAlignDraw() {
  if (!align.raf) align.raf = requestAnimationFrame(drawAlign);
}
function drawAlign() {
  align.raf = 0;
  const c = el.aCanvas, g = c.getContext('2d');
  const W = c.width, H = c.height;
  if (!W || !H || !align.src) return;
  const { k, ox, oy } = fitBox(W, H);
  const dpr = W / (el.aCanvas.clientWidth || W);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = align.mean;
  g.fillRect(0, 0, W, H);
  g.imageSmoothingQuality = 'high';
  applyAlignTransform(g, k, ox, oy);
  g.drawImage(align.src, -align.iw / 2, -align.ih / 2);
  g.setTransform(1, 0, 0, 1, 0, 0);

  g.beginPath();                                   // dim outside the egg window
  g.rect(0, 0, W, H);
  traceEgg(g, k, ox, oy);
  g.fillStyle = 'rgba(10, 12, 15, 0.55)';
  g.fill('evenodd');
  g.beginPath();
  traceEgg(g, k, ox, oy);
  g.lineWidth = 1.5 * dpr;
  g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  g.stroke();

  const P = (x, y) => [ox + texX(x) * k, oy + texY(y) * k];
  g.save();
  g.shadowColor = 'rgba(0, 0, 0, 0.6)';
  g.shadowBlur = 3 * dpr;
  g.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  g.fillStyle = 'rgba(255, 255, 255, 0.95)';
  g.lineWidth = 1.5 * dpr;
  g.lineCap = 'round';
  const rEye = 0.42 * PX * k;
  for (const e of [LM.eyeL, LM.eyeR]) {
    const [x, y] = P(e[0], e[1]);
    g.beginPath();
    g.arc(x, y, rEye, 0, Math.PI * 2);
    g.stroke();
  }
  const [nx, ny0] = P(LM.noseTip[0], LM.noseTip[1] + 0.5);
  const [, ny1] = P(LM.noseTip[0], LM.noseTip[1]);
  g.beginPath();
  g.moveTo(nx, ny0);
  g.lineTo(nx, ny1);
  g.moveTo(nx - 0.18 * PX * k, ny1);
  g.lineTo(nx + 0.18 * PX * k, ny1);
  g.stroke();
  const [mx0, my] = P(LM.mouth[0] - LM.mouthHalfW, LM.mouth[1]);
  const [mx1] = P(LM.mouth[0] + LM.mouthHalfW, LM.mouth[1]);
  g.beginPath();
  g.moveTo(mx0, my);
  g.lineTo(mx1, my);
  g.moveTo(mx0, my - 4 * dpr);
  g.lineTo(mx0, my + 4 * dpr);
  g.moveTo(mx1, my - 4 * dpr);
  g.lineTo(mx1, my + 4 * dpr);
  g.stroke();
  g.font = `500 ${Math.round(11 * dpr)}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
  g.textBaseline = 'middle';
  const [ex, ey] = P(LM.eyeR[0], LM.eyeR[1]);
  g.fillText('eyes', ex + rEye + 6 * dpr, ey);
  g.fillText('mouth', mx1 + 8 * dpr, my);
  g.restore();
}

function renderAlignedTexture() {
  const c = makeCanvas(TEX_W, TEX_H), g = c.getContext('2d');
  g.fillStyle = align.mean;                        // uncovered areas take the photo's mean color
  g.fillRect(0, 0, TEX_W, TEX_H);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  applyAlignTransform(g, 1);
  g.drawImage(align.src, -align.iw / 2, -align.ih / 2);
  g.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

function commitAlign() {
  if (!align.src || !stage) return;
  const tex = renderAlignedTexture();
  const photo = { src: align.src, mean: align.mean, transform: pickFit(align), initial: pickFit(align.initial || coverFit()) };
  el.dialog.close('pour');
  setFace(tex, 'photo', photo);
  hideFaceError();
  pour();
  toast('Poured a fresh jelly from your photo.');
}

function wireAlign() {
  const cv = el.aCanvas;
  const baseline = () => {
    const ps = [...align.ptrs.values()];
    if (ps.length >= 2) {
      const [a, b] = ps;
      align.gest = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, zoom: align.zoom, tx: align.tx, ty: align.ty };
    } else if (ps.length === 1) {
      align.gest = { type: 'drag', x: ps[0].x, y: ps[0].y, tx: align.tx, ty: align.ty };
    } else {
      align.gest = null;
    }
  };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    cv.focus({ preventScroll: true });
    align.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    baseline();
  });
  cv.addEventListener('pointermove', (e) => {
    const p = align.ptrs.get(e.pointerId);
    if (!p || !align.gest) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const gs = align.gest;
    if (gs.type === 'drag') {
      const kc = alignCssBox().k;
      align.tx = gs.tx + (e.clientX - gs.x) / kc;
      align.ty = gs.ty + (e.clientY - gs.y) / kc;
      clampAlign();
    } else if (gs.type === 'pinch' && align.ptrs.size >= 2) {
      const [a, b] = [...align.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const z = clamp((gs.zoom * d) / (gs.d || 1), 1, 6), f = z / gs.zoom;
      const m0 = clientToTex(gs.mx, gs.my), m1 = clientToTex((a.x + b.x) / 2, (a.y + b.y) / 2);
      align.tx = m1[0] + (gs.tx - m0[0]) * f;
      align.ty = m1[1] + (gs.ty - m0[1]) * f;
      align.zoom = z;
      clampAlign();
    }
    alignChanged();
  });
  const up = (e) => {
    if (!align.ptrs.has(e.pointerId)) return;
    align.ptrs.delete(e.pointerId);
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* released */ }
    baseline();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    const rate = e.ctrlKey ? 0.01 : 0.0015;
    const [px, py] = clientToTex(e.clientX, e.clientY);
    zoomAbout(px, py, align.zoom * Math.exp(-clamp(dy, -240, 240) * rate));
    alignChanged();
  }, { passive: false });
  cv.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 24 : 4;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': align.tx -= step; break;
      case 'ArrowRight': align.tx += step; break;
      case 'ArrowUp': align.ty -= step; break;
      case 'ArrowDown': align.ty += step; break;
      case '+': case '=': zoomAbout(TEX_W / 2, TEX_H / 2, align.zoom * 1.06); break;
      case '-': case '_': case '−': zoomAbout(TEX_W / 2, TEX_H / 2, align.zoom / 1.06); break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    clampAlign();
    alignChanged();
  });
  el.aZoom.addEventListener('input', () => { zoomAbout(TEX_W / 2, TEX_H / 2, Number(el.aZoom.value)); alignChanged(); });
  el.aRotate.addEventListener('input', () => { rotateAbout(TEX_W / 2, TEX_H / 2, Number(el.aRotate.value)); alignChanged(); });
  el.aReset.addEventListener('click', () => {
    Object.assign(align, align.initial || coverFit());
    syncAlignInputs();
    requestAlignDraw();
  });
  el.aCancel.addEventListener('click', () => el.dialog.close('cancel'));
  el.aPour.addEventListener('click', commitAlign);
  el.dialog.addEventListener('close', () => {
    align.token++;                                  // drop late face-detector results
    align.ptrs.clear();
    align.gest = null;
    if (!face.photo || face.photo.src !== align.src) align.src = null;
  });
  new ResizeObserver(sizeAlignCanvas).observe(el.aView);
}

// ---------------------------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------------------------
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week']);
function isTextField(t) {
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && TEXT_TYPES.has((t.type || 'text').toLowerCase());
}
// Does the focused element keep Space for itself? Text fields always do. Buttons, switches, radios and links
// do when they were reached from the keyboard (Tab), so Space presses them as usual; after a mouse or touch
// press Space goes back to being the pause key. Sliders never use Space.
function claimsSpace(t) {
  if (!t || !t.tagName) return false;
  if (isTextField(t)) return true;
  if (t.tagName === 'INPUT' && (t.type || '').toLowerCase() === 'range') return false;
  const control = ['BUTTON', 'INPUT', 'SUMMARY', 'A'].includes(t.tagName) || t.getAttribute('role') === 'button';
  return control && modality.focusFrom === 'key';
}
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!stage || el.dialog.open) return;
    const t = e.target;
    if (isTextField(t)) return;
    if (e.key === ' ' || e.code === 'Space') {
      if (claimsSpace(t)) return;
      e.preventDefault();                   // also on auto-repeat, so a held Space never presses a clicked button
      if (!e.repeat) setPaused(!ui.paused);
      return;
    }
    if (e.repeat) return;
    switch (e.key.toLowerCase()) {
      case 'h': setTool('hand'); break;
      case 'k': setTool('knife'); break;
      case 'r': pourAgain(); break;
      case 'n': nudge(); break;
      case 'm': setShowMesh(!ui.showMesh); break;
      default: return;
    }
    e.preventDefault();
  });
}

// ---------------------------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------------------------
let raf = 0, lastT = 0, lastReadout = 0, loopErrors = 0;
function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = lastT ? clamp((now - lastT) / 1000, 0, 1 / 30) : 1 / 60;
  lastT = now;
  if ((window.devicePixelRatio || 1) !== fittedDpr) fitStage();
  try {
    if (!ui.paused && dt > 0) world.step(dt * (ui.quarter ? 0.25 : 1));
    stage.sync(world);
    stage.render();
  } catch (err) {
    if (loopErrors++ < 3) console.error('[jelly-face] frame failed', err);
  }
  drawTrail(now);
  if (now - lastReadout >= 166) {
    lastReadout = now;
    updateReadouts();
  }
}
function startLoop() {
  if (raf || !stage || document.hidden) return;
  lastT = 0;
  raf = requestAnimationFrame(frame);
}
function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
function boot() {
  try {
    stage = createStage(el.canvas);
  } catch (err) {
    stage = null;
    console.warn('[jelly-face] 3D stage unavailable:', err && err.message ? err.message : err);
  }
  theme = null;
  applyTheme();
  trackModality();
  // Drag-and-drop and paste don't exist on a phone or a tablet without a mouse; point to the picker instead.
  const faceNote = () => setText(el.faceNote, touchOnly.matches ? FACE_NOTE.touch : FACE_NOTE.desk);
  faceNote();
  touchOnly.addEventListener('change', faceNote);
  wireControls();
  wireStage();
  wireFileSources();
  wireAlign();
  wireKeys();
  setFace(drawSampleFace(), 'sample');

  if (!stage) {
    el.fallback.hidden = false;
    el.canvas.hidden = true;
    el.trail.hidden = true;
    for (const n of el.frame.querySelectorAll('.stage-tools, .stage-meta')) n.hidden = true;
    disableControls();
    syncFromControls();
    updateStatus();
    return;
  }

  syncFromControls();
  setTool('hand');
  fitStage();
  new ResizeObserver(fitStage).observe(el.frame);
  window.addEventListener('resize', fitStage);
  pour();
  updateReadouts();

  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  darkScheme.addEventListener('change', applyTheme);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLoop();
      cancelGesture();
    } else {
      startLoop();
    }
    updateStatus();
  });
  updateStatus();
  startLoop();
}

boot();

// ---------------------------------------------------------------------------------------------
// Debug / test hook
// ---------------------------------------------------------------------------------------------
window.__jellyFace = {
  world,
  stage,
  loadFile,
  pourSample: () => { if (stage) pourSample(); },
  setTool,
  sliceScreen(ax, ay, bx, by) {
    if (!stage) return null;
    trail = { pts: [[ax, ay], [bx, by]], fadeStart: performance.now() + 250 };
    trailDirty = true;
    return sliceClient([ax, ay], [bx, by]);
  },
  pickScreen(x, y) {
    if (!stage) return null;
    const [nx, ny] = ndcOf(x, y);
    return stage.pick(nx, ny);
  },
  state() {
    let metrics = null;
    try { metrics = world.metrics(); } catch (err) { metrics = null; }
    return {
      webgl: !!stage,
      tool: ui.tool,
      paused: ui.paused,
      quarter: ui.quarter,
      showMesh: ui.showMesh,
      flavor: ui.flavor,
      params: { ...world.params },
      depth: Number(el.depth.value),
      emboss: Number(el.emboss.value),
      clarity: Number(el.clarity.value),
      face: face.kind,
      dialogOpen: el.dialog.open,
      align: el.dialog.open ? pickFit(align) : null,
      version: world.version,
      bodies: world.bodies.length,
      metrics,
      theme: theme ? { ...theme } : null,
      running: !!raf,
    };
  },
  // extras for tests
  faceCanvas: () => face.texture,
  thumbCanvas: () => face.thumb,
  faceLum: () => face.lum,
  pourAligned: () => { if (el.dialog.open) commitAlign(); return !el.dialog.open; },
  toast,
};
