// physics.js -- XPBD soft-body simulation for Jelly Face (no DOM, no three.js; Node-testable).
//
// Units cm, g, s. World frame: y up, the cutting mat top is y = 0. A freshly poured body lies face-up:
// world = (x, z + T/2 + lift, -y) for rest (x, y, z).
// Fixed substep h = 1/600 s, one XPBD iteration per substep ("small steps"): edge distance constraints and
// tet volume constraints (C = 6(V - V0)), compliance scaled by 1/h^2; then ground/wall contact with friction,
// grab, inter-body particle collisions; then velocity update, per-edge relative-velocity damping and a light drag.

import { FACE, faceOutline, makeRelief, makeBubbles, buildPiece, embedPoints, splitConvex, roundPolygon, polygonArea, inradius } from './geom.js';

const H = 1 / 600;
const GRAVITY = -981;
const DENSITY = 1.05;
const WALL = 28;
const CEILING = 36; // just above the highest grab (grabMaxHeight 30 + patch radius); keeps the jelly near the view
const MAX_SUBSTEPS = 40;
const MAX_BODIES = 24;

// ---- tuning (see NOTES-core.md for the measured behaviour). Exported so tests can read the constants. ----
export const TUNING = {
  // Edge compliance per unit length: alpha_e = compliance(firmness) / restLength_e  (units s^2/g * cm).
  // firmness 0 -> edgeComplianceSoft, 1 -> edgeComplianceFirm, log-linear in between.
  edgeComplianceSoft: 6e-4,
  edgeComplianceFirm: 1.9e-4,
  // Volume constraint C = 6(V - V0): alpha_t = 36 V0 / bulkModulus (dyn/cm^2).
  bulkModulus: 8e4,
  // One extra constraint per body on its total volume (divergence theorem over the tet-mesh boundary),
  // compliance 36 V / globalBulkModulus. Keeps the total volume while the per-tet constraints stay soft.
  globalBulkModulus: 2e6,
  // Per-edge relative-velocity damping rate (1/s) = dampRateMax * damping^dampExponent.
  dampRateMax: 900,
  dampExponent: 3,
  drag: 0.02,            // light global drag (1/s) at damping 0 ...
  dragPerDamping: 0.3,   // ... plus this much per unit of the damping slider
  muStatic: 0.8,         // ground friction (gelatin on a mat is tacky, but not so tacky that it pins a
  muKinetic: 0.6,        // deformed body in place and keeps it from relaxing back)
  // Strain stiffening (gelatin stiffens as it is strained): an edge strained by more than stiffenStrain (either
  // way) gets its compliance divided by 1 + stiffenRate * (|strain| - stiffenStrain). Sag and wobble stay soft and
  // lively; a crumpled or folded body pushes back hard enough to beat the mat friction and relax (with linear
  // edges only the friction was holding a pulled body's shape, so it stayed crumpled).
  stiffenStrain: 0.1,
  stiffenRate: 30,
  restitution: 0,        // floor restitution for impacts faster than restitutionMinSpeed (cm/s)
  restitutionMinSpeed: 10,
  // Inter-body contact: boundary particles of one piece against the outward boundary faces of the others.
  contactSkin: 0.1,      // particles are kept this far outside other pieces' surfaces (cm)
  contactSearch: 0.5,    // faces farther than this from a particle are not considered (cm)
  contactCell: 1.2,      // hash cell size (cm)
  contactMaxPush: 0.3,   // max correction per contact per substep (cm)
  contactMuStatic: 0.6,  // jelly-on-jelly friction
  contactMuKinetic: 0.45,
  // A tet squashed below invertFrac of its rest volume (or turned inside out) is projected back onto exactly that
  // fraction with zero compliance, so a crumpled body can't rest in an inverted state. It is a one-sided floor, like
  // the mat: pushing further (an earlier version jumped to 25 %) made the force jump at the threshold, and a tet
  // pinned at a wall/mat corner then chattered every substep (a limit cycle that never settled).
  invertFrac: 0.1,
  maxStretch: 2.2,       // strain limit applied inside the edge constraint (edge length <= maxStretch * rest)
  grabRadius: 3,         // particles within this distance of the hit point form the grab patch
  grabStiffness: 3e5,    // total spring stiffness of the grab patch (g/s^2)
  grabReach: 2,          // effective anchor kept within this distance of the grabbed point (cm); bounds the pull
                         // force to grabStiffness * grabReach (about 2.2x the weight of a whole face)
  grabMaxHeight: 30,     // the effective anchor is also kept inside |x|,|z| <= 28 - grabRadius - 2, y in [0.2, 30]
  grabMaxSpeed: 80,      // ... and moves toward the requested anchor at most this fast (cm/s)
  grabMaxAccel: 400,     // ... with at most this acceleration (cm/s^2), braking to stop on the target
  grabPressDepth: 1,     // ... and never more than this far below the grabbed point's starting height (cm):
                         // the Hand pulls; pressing the patch down into its own body only crumpled it
  nudgeSpeed: 70,        // a nudge sets each piece's mean upward speed to this (cm/s) ...
  nudgeCooldown: 0.25,   // ... at most once per this much simulated time (s)
  // Cut corners are filleted with radius <= FACE.cornerRadius, chosen per piece so no new corner loses more
  // than filletMaxLoss cm^2 of area (acute wedges get smaller fillets), and never larger than the smallest
  // fillet the piece already has (so the opening leaves older corners untouched).
  filletMaxLoss: 0.09,
  filletMinRadius: 0.2,
  wedgeSpeed: 10,        // cut pieces get +-wedgeSpeed (cm/s) along the horizontal blade normal ...
  cutGap: 0.64,          // ... and slide apart rigidly at that speed until their cut faces are this far apart (cm)
  pokeRadius: 1.6,
  maxSpeed: 1500,        // cm/s safety clamp
};

const MSG_SWIPE = 'Swipe all the way across a piece to cut it.';
const MSG_ALONG = 'That cut runs along the jelly, not through it.';
const MSG_THIN = 'Too thin to slice.';
const MSG_PLENTY = 'That is plenty of pieces. Reset to pour a fresh one.';

let nextBodyId = 1;

function clamp01(v) {
  v = Number(v);
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

export class Body {
  constructor(geo) {
    this.id = nextBodyId++;
    this.geo = geo;
    const P = geo.particles, T = geo.tets, E = geo.edges;
    const n = P.length / 3, m = T.length / 4, ne = E.length / 2;
    this.n = n;
    this.m = m;
    this.x = new Float32Array(3 * n);
    this.v = new Float32Array(3 * n);
    this.p = new Float32Array(3 * n);
    this.mass = new Float32Array(n);
    this.w = new Float32Array(n);
    this.restVol = new Float32Array(m);
    let total = 0;
    for (let t = 0; t < m; t++) {
      const a = T[4 * t], b = T[4 * t + 1], c = T[4 * t + 2], d = T[4 * t + 3];
      const vol = tetVolume(P, a, b, c, d);
      this.restVol[t] = vol;
      total += vol;
      const q = (DENSITY * vol) / 4;
      this.mass[a] += q; this.mass[b] += q; this.mass[c] += q; this.mass[d] += q;
    }
    this.restVolume = total;
    let tm = 0;
    for (let i = 0; i < n; i++) {
      tm += this.mass[i];
      this.w[i] = this.mass[i] > 0 ? 1 / this.mass[i] : 0;
    }
    this.totalMass = tm;
    this.restLen = new Float32Array(ne);
    this.invRestLen = new Float32Array(ne);
    for (let e = 0; e < ne; e++) {
      const i = 3 * E[2 * e], j = 3 * E[2 * e + 1];
      const l = Math.hypot(P[j] - P[i], P[j + 1] - P[i + 1], P[j + 2] - P[i + 2]);
      this.restLen[e] = l;
      this.invRestLen[e] = l > 1e-9 ? 1 / l : 0;
    }
    // particles on the tet-mesh boundary (used for inter-body collisions)
    const cols = geo.cols || 0, L = geo.layers || 0, nbc = geo.boundaryCols || 0;
    const surf = [];
    for (let i = 0; i < n; i++) {
      if (!cols) { surf.push(i); continue; }
      const k = Math.floor(i / cols), c = i - k * cols;
      if (k === 0 || k === L || c < nbc) surf.push(i);
    }
    this.surfIdx = Uint32Array.from(surf);
    // boundary faces of the tet mesh, outward (faces used by exactly one tet)
    const faceMap = new Map();
    const FACES = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
    for (let t = 0; t < m; t++) {
      for (const f of FACES) {
        const a = T[4 * t + f[0]], b = T[4 * t + f[1]], c = T[4 * t + f[2]];
        const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
        const key = (lo * n + mid) * n + hi;
        const e = faceMap.get(key);
        if (e) e.count++;
        else faceMap.set(key, { count: 1, a, b, c });
      }
    }
    const bf = [];
    for (const f of faceMap.values()) if (f.count === 1) bf.push(f.a, f.b, f.c);
    this.boundaryFaces = Uint32Array.from(bf);
    this._grad = new Float32Array(3 * n);
    this.surfacePositions = new Float32Array(geo.surface.positions.length);
    this.bubblePositions = new Float32Array(geo.bubbles.rest.length);
    this.lastCentroid = new Float64Array(3);
    this.minFillet = FACE.cornerRadius; // smallest fillet radius on this outline (slicing bookkeeping)
    this.slide = null;                  // { dx, dz, left }: pending rigid slide of a freshly cut piece
    // Render interpolation: World.step leaves a remainder of less than one substep in its accumulator.
    // updateSurface draws lerp(p, x, alpha) (p = start of the last substep) so the drawn time advances evenly
    // at any frame rate or speed. alpha = 1 draws x itself.
    this.alpha = 1;
    this._rx = null;
  }

  // face-up rest pose: world = (x, z + T/2 + lift, -y)
  placeFaceUp(lift = 0) {
    const P = this.geo.particles, x = this.x;
    const T = FACE.T;
    for (let i = 0; i < this.n; i++) {
      x[3 * i] = P[3 * i];
      x[3 * i + 1] = P[3 * i + 2] + T / 2 + lift;
      x[3 * i + 2] = -P[3 * i + 1];
    }
    this.p.set(x);
    this.v.fill(0);
    this.centroid(this.lastCentroid);
  }

  centroid(out = [0, 0, 0]) {
    const x = this.x, ms = this.mass;
    let sx = 0, sy = 0, sz = 0, s = 0;
    for (let i = 0; i < this.n; i++) {
      const q = ms[i];
      sx += q * x[3 * i]; sy += q * x[3 * i + 1]; sz += q * x[3 * i + 2];
      s += q;
    }
    s = s || 1;
    out[0] = sx / s; out[1] = sy / s; out[2] = sz / s;
    return out;
  }

  updateSurface() {
    let src = this.x;
    const a = this.alpha;
    if (a >= 0 && a < 1 - 1e-6) {
      const x = this.x, p = this.p;
      const r = this._rx && this._rx.length === x.length ? this._rx : (this._rx = new Float32Array(x.length));
      for (let i = 0; i < x.length; i++) r[i] = p[i] + (x[i] - p[i]) * a;
      src = r;
    }
    interpolate(src, this.geo.tets, this.geo.surface.tetOf, this.geo.surface.bary, this.surfacePositions);
    if (this.bubblePositions.length) {
      interpolate(src, this.geo.tets, this.geo.bubbles.tetOf, this.geo.bubbles.bary, this.bubblePositions);
    }
  }
}

function interpolate(x, tets, tetOf, bary, out) {
  const k = tetOf.length;
  for (let q = 0; q < k; q++) {
    const t = 4 * tetOf[q];
    const a = 3 * tets[t], b = 3 * tets[t + 1], c = 3 * tets[t + 2], d = 3 * tets[t + 3];
    const w0 = bary[4 * q], w1 = bary[4 * q + 1], w2 = bary[4 * q + 2], w3 = bary[4 * q + 3];
    out[3 * q] = w0 * x[a] + w1 * x[b] + w2 * x[c] + w3 * x[d];
    out[3 * q + 1] = w0 * x[a + 1] + w1 * x[b + 1] + w2 * x[c + 1] + w3 * x[d + 1];
    out[3 * q + 2] = w0 * x[a + 2] + w1 * x[b + 2] + w2 * x[c + 2] + w3 * x[d + 2];
  }
}

function tetVolume(P, a, b, c, d) {
  const x0 = P[3 * a], y0 = P[3 * a + 1], z0 = P[3 * a + 2];
  const e1x = P[3 * b] - x0, e1y = P[3 * b + 1] - y0, e1z = P[3 * b + 2] - z0;
  const e2x = P[3 * c] - x0, e2y = P[3 * c + 1] - y0, e2z = P[3 * c + 2] - z0;
  const e3x = P[3 * d] - x0, e3y = P[3 * d + 1] - y0, e3z = P[3 * d + 2] - z0;
  return ((e1y * e2z - e1z * e2y) * e3x + (e1z * e2x - e1x * e2z) * e3y + (e1x * e2y - e1y * e2x) * e3z) / 6;
}

// Barycentric weights (into out[0..2]) of the point of triangle (a, b, c) closest to p, by Voronoi regions
// (the standard vertex / edge / face region tests).
function closestBary(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = 1; out[1] = 0; out[2] = 0; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = 0; out[1] = 1; out[2] = 0; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = 1 - v; out[1] = v; out[2] = 0; return; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = 0; out[1] = 0; out[2] = 1; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); out[0] = 1 - t; out[1] = 0; out[2] = t; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = 0; out[1] = 1 - t; out[2] = t;
    return;
  }
  const s = 1 / (va + vb + vc);
  const v = vb * s, t = vc * s;
  out[0] = 1 - v - t; out[1] = v; out[2] = t;
}

// symmetric 3x3 eigen-decomposition (Jacobi). a = [xx, xy, xz, yy, yz, zz]; returns {values, vectors} sorted desc.
function eigSym3(a) {
  const A = [[a[0], a[1], a[2]], [a[1], a[3], a[4]], [a[2], a[4], a[5]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    const off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
    if (off < 1e-24) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq;
        A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk;
        A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => A[j][j] - A[i][i]);
  return {
    values: idx.map((i) => A[i][i]),
    vectors: idx.map((i) => [V[0][i], V[1][i], V[2][i]]),
  };
}

export class World {
  params = { firmness: 0.55, damping: 0.45 };
  bodies = [];
  version = 0;
  grab = null;

  constructor() {
    this.time = 0;
    this.gravity = GRAVITY; // cm/s^2 along world y (tests may change it)
    this.relief = null;
    this._acc = 0;
    this._bubbles = makeBubbles();
    this._nudges = 0;
    this._nudgePending = false;
    this._lastNudge = -Infinity;
    this._scratchKey = '';
    this._cs = null;
  }

  // ------------------------------------------------------------------ lifecycle
  pour(relief, { lift = 5 } = {}) {
    this.relief = relief || makeRelief();
    const geo = buildPiece(faceOutline(), this.relief, { bubbles: this._bubbles });
    const b = new Body(geo);
    b.placeFaceUp(Number.isFinite(lift) ? Math.max(0, lift) : 5);
    this.bodies = [b];
    this.grab = null;
    this._acc = 0;
    this._nudgePending = false;
    this.version++;
    return b;
  }

  remold(relief) {
    this.relief = relief || makeRelief();
    const out = [];
    for (const old of this.bodies) {
      let geo;
      try {
        geo = buildPiece(old.geo.outline, this.relief, { bubbles: this._bubbles });
      } catch (e) {
        out.push(old);
        continue;
      }
      const nb = new Body(geo);
      nb.minFillet = old.minFillet;
      transferRemold(old, nb);
      nb.centroid(nb.lastCentroid);
      out.push(nb);
    }
    this.bodies = out;
    this.grab = null;
    this.version++;
  }

  // ------------------------------------------------------------------ stepping
  step(dt) {
    if (!(dt > 0) || !this.bodies.length) return;
    this._acc += Math.min(dt, 0.5);
    let n = Math.floor(this._acc / H + 1e-9);
    if (n > MAX_SUBSTEPS) {
      n = MAX_SUBSTEPS;
      this._acc = 0;
    } else {
      this._acc -= n * H;
      if (this._acc < 0) this._acc = 0;
    }
    if (n === 0) { this._setAlpha(); return; }
    this._ensureScratch();
    if (this._nudgePending) this._applyNudge();
    const f = clamp01(this.params.firmness), dmp = clamp01(this.params.damping);
    const alphaEdge = Math.exp(Math.log(TUNING.edgeComplianceSoft) + f * (Math.log(TUNING.edgeComplianceFirm) - Math.log(TUNING.edgeComplianceSoft))) / (H * H);
    const alphaVol = 36 / TUNING.bulkModulus / (H * H);
    const alphaGlobal = TUNING.globalBulkModulus > 0 ? 36 / TUNING.globalBulkModulus / (H * H) : -1;
    const dampRate = TUNING.dampRateMax * Math.pow(dmp, TUNING.dampExponent);
    const beta = 1 - Math.exp(-dampRate * H);
    const drag = Math.exp(-(TUNING.drag + TUNING.dragPerDamping * dmp) * H);
    const multi = this.bodies.length > 1;
    for (let s = 0; s < n; s++) {
      for (const b of this.bodies) this._predict(b, drag);
      for (const b of this.bodies) {
        this._solveInternal(b, alphaEdge, alphaVol);
        if (alphaGlobal >= 0) this._solveGlobalVolume(b, alphaGlobal);
      }
      if (this.grab) this._solveGrab();
      if (multi) this._collide();
      for (const b of this.bodies) this._contactAndVelocity(b, beta);
    }
    this.time += n * H;
    this._guard();
    this._setAlpha();
  }

  // fraction of a substep left in the accumulator, for Body.updateSurface's interpolation
  _setAlpha() {
    const a = Math.min(1, Math.max(0, this._acc / H));
    for (const b of this.bodies) b.alpha = a;
  }

  _predict(b, drag) {
    const x = b.x, v = b.v, p = b.p, w = b.w, n = b.n;
    const gh = this.gravity * H;
    if (b.slide) {
      // fresh piece: rigid slide away from its sibling (x and p move together: no velocity, no friction)
      const sl = b.slide, s = Math.min(sl.left, TUNING.wedgeSpeed * H);
      const sx = sl.dx * s, sz = sl.dz * s;
      for (let i = 0; i < n; i++) {
        const i3 = 3 * i;
        let nx = x[i3] + sx, nz = x[i3 + 2] + sz;
        nx = nx > WALL ? WALL : nx < -WALL ? -WALL : nx;
        nz = nz > WALL ? WALL : nz < -WALL ? -WALL : nz;
        x[i3] = nx; x[i3 + 2] = nz;
      }
      sl.left -= s;
      if (!(sl.left > 1e-9)) b.slide = null;
    }
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      p[i3] = x[i3]; p[i3 + 1] = x[i3 + 1]; p[i3 + 2] = x[i3 + 2];
      if (w[i] === 0) continue;
      const vx = v[i3] * drag, vy = (v[i3 + 1] + gh) * drag, vz = v[i3 + 2] * drag;
      v[i3] = vx; v[i3 + 1] = vy; v[i3 + 2] = vz;
      x[i3] += vx * H; x[i3 + 1] += vy * H; x[i3 + 2] += vz * H;
    }
  }

  _solveInternal(b, alphaEdge, alphaVol) {
    const x = b.x, w = b.w;
    const E = b.geo.edges, rl = b.restLen, irl = b.invRestLen, ne = rl.length;
    const smax = TUNING.maxStretch, s0 = TUNING.stiffenStrain, sk = TUNING.stiffenRate;
    for (let e = 0; e < ne; e++) {
      const i = E[2 * e], j = E[2 * e + 1];
      const wi = w[i], wj = w[j], ws = wi + wj;
      if (ws === 0) continue;
      const i3 = 3 * i, j3 = 3 * j;
      const dx = x[j3] - x[i3], dy = x[j3 + 1] - x[i3 + 1], dz = x[j3 + 2] - x[i3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const C = len - rl[e];
      let a = alphaEdge * irl[e];
      const strain = Math.abs(C) * irl[e];
      if (strain > s0) a /= 1 + sk * (strain - s0);
      let dl = -C / (ws + a);
      // strain limit (gelatin stiffens in tension): never leave an edge longer than smax * rest
      const lim = smax * rl[e];
      if (len + ws * dl > lim) dl = (lim - len) / ws;
      const s = dl / len;
      x[i3] -= wi * s * dx; x[i3 + 1] -= wi * s * dy; x[i3 + 2] -= wi * s * dz;
      x[j3] += wj * s * dx; x[j3 + 1] += wj * s * dy; x[j3 + 2] += wj * s * dz;
    }
    const T = b.geo.tets, rv = b.restVol, m = b.m;
    const invLo = 6 * TUNING.invertFrac;
    for (let t = 0; t < m; t++) {
      const i0 = 3 * T[4 * t], i1 = 3 * T[4 * t + 1], i2 = 3 * T[4 * t + 2], i3 = 3 * T[4 * t + 3];
      const w0 = w[T[4 * t]], w1 = w[T[4 * t + 1]], w2 = w[T[4 * t + 2]], w3 = w[T[4 * t + 3]];
      const x0 = x[i0], y0 = x[i0 + 1], z0 = x[i0 + 2];
      const e1x = x[i1] - x0, e1y = x[i1 + 1] - y0, e1z = x[i1 + 2] - z0;
      const e2x = x[i2] - x0, e2y = x[i2 + 1] - y0, e2z = x[i2 + 2] - z0;
      const e3x = x[i3] - x0, e3y = x[i3 + 1] - y0, e3z = x[i3 + 2] - z0;
      // g1 = e2 x e3, g2 = e3 x e1, g3 = e1 x e2, g0 = -(g1 + g2 + g3)
      const g1x = e2y * e3z - e2z * e3y, g1y = e2z * e3x - e2x * e3z, g1z = e2x * e3y - e2y * e3x;
      const g2x = e3y * e1z - e3z * e1y, g2y = e3z * e1x - e3x * e1z, g2z = e3x * e1y - e3y * e1x;
      const g3x = e1y * e2z - e1z * e2y, g3y = e1z * e2x - e1x * e2z, g3z = e1x * e2y - e1y * e2x;
      const g0x = -g1x - g2x - g3x, g0y = -g1y - g2y - g3y, g0z = -g1z - g2z - g3z;
      const V6 = e1x * g1x + e1y * g1y + e1z * g1z;
      // Edge lengths are mirror-symmetric, so an inside-out tet satisfies them as well as an upright one and the
      // soft volume term alone can't flip it back: a squashed or inverted tet is projected onto the invertFrac floor.
      const squashed = V6 < invLo * rv[t];
      const C = squashed ? V6 - invLo * rv[t] : V6 - 6 * rv[t];
      const den = w0 * (g0x * g0x + g0y * g0y + g0z * g0z) + w1 * (g1x * g1x + g1y * g1y + g1z * g1z)
        + w2 * (g2x * g2x + g2y * g2y + g2z * g2z) + w3 * (g3x * g3x + g3y * g3y + g3z * g3z) + (squashed ? 0 : alphaVol * rv[t]);
      if (den < 1e-12) continue;
      const dl = -C / den;
      let s = w0 * dl; x[i0] += s * g0x; x[i0 + 1] += s * g0y; x[i0 + 2] += s * g0z;
      s = w1 * dl; x[i1] += s * g1x; x[i1 + 1] += s * g1y; x[i1 + 2] += s * g1z;
      s = w2 * dl; x[i2] += s * g2x; x[i2 + 1] += s * g2y; x[i2 + 2] += s * g2z;
      s = w3 * dl; x[i3] += s * g3x; x[i3 + 1] += s * g3y; x[i3 + 2] += s * g3z;
    }
  }

  _solveGlobalVolume(b, alphaG) {
    const F = b.boundaryFaces, nf = F.length / 3, x = b.x, w = b.w, G = b._grad;
    G.fill(0);
    let v6 = 0;
    for (let f = 0; f < nf; f++) {
      const a = 3 * F[3 * f], c1 = 3 * F[3 * f + 1], c2 = 3 * F[3 * f + 2];
      const ax = x[a], ay = x[a + 1], az = x[a + 2];
      const bx = x[c1], by = x[c1 + 1], bz = x[c1 + 2];
      const cx = x[c2], cy = x[c2 + 1], cz = x[c2 + 2];
      // d(a . (b x c)) / da = b x c, / db = c x a, / dc = a x b
      const gax = by * cz - bz * cy, gay = bz * cx - bx * cz, gaz = bx * cy - by * cx;
      v6 += ax * gax + ay * gay + az * gaz;
      G[a] += gax; G[a + 1] += gay; G[a + 2] += gaz;
      G[c1] += cy * az - cz * ay; G[c1 + 1] += cz * ax - cx * az; G[c1 + 2] += cx * ay - cy * ax;
      G[c2] += ay * bz - az * by; G[c2 + 1] += az * bx - ax * bz; G[c2 + 2] += ax * by - ay * bx;
    }
    const C = v6 - 6 * b.restVolume;
    let den = alphaG * b.restVolume;
    const n = b.n;
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      den += w[i] * (G[i3] * G[i3] + G[i3 + 1] * G[i3 + 1] + G[i3 + 2] * G[i3 + 2]);
    }
    if (den < 1e-12) return;
    const dl = -C / den;
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i, s = w[i] * dl;
      x[i3] += s * G[i3]; x[i3 + 1] += s * G[i3 + 1]; x[i3 + 2] += s * G[i3 + 2];
    }
  }

  _contactAndVelocity(b, beta) {
    const x = b.x, v = b.v, p = b.p, n = b.n;
    const invH = 1 / H;
    const muS = TUNING.muStatic, muK = TUNING.muKinetic, rest = TUNING.restitution, restMin = TUNING.restitutionMinSpeed;
    const maxSpeed = TUNING.maxSpeed;
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      let px = x[i3], py = x[i3 + 1], pz = x[i3 + 2];
      let bounce = 0;
      if (py < 0) {
        const vin = v[i3 + 1];
        if (rest > 0 && vin < -restMin) bounce = -rest * vin;
        // ground contact with position-based static / kinetic friction
        const depth = -py;
        py = 0;
        const tx = px - p[i3], tz = pz - p[i3 + 2];
        const tl = Math.sqrt(tx * tx + tz * tz);
        if (tl < muS * depth) {
          px = p[i3]; pz = p[i3 + 2];
        } else if (tl > 0) {
          const k = Math.max(0, 1 - (muK * depth) / tl);
          px = p[i3] + tx * k; pz = p[i3 + 2] + tz * k;
        }
      }
      if (py > CEILING) py = CEILING;
      if (px > WALL) px = WALL; else if (px < -WALL) px = -WALL;
      if (pz > WALL) pz = WALL; else if (pz < -WALL) pz = -WALL;
      x[i3] = px; x[i3 + 1] = py; x[i3 + 2] = pz;
      let vx = (px - p[i3]) * invH, vy = (py - p[i3 + 1]) * invH, vz = (pz - p[i3 + 2]) * invH;
      if (bounce > 0 && bounce > vy) vy = bounce;
      const sp = vx * vx + vy * vy + vz * vz;
      if (sp > maxSpeed * maxSpeed) {
        const k = maxSpeed / Math.sqrt(sp);
        vx *= k; vy *= k; vz *= k;
      }
      v[i3] = vx; v[i3 + 1] = vy; v[i3 + 2] = vz;
    }
    if (beta > 0) {
      // internal damping: reduce the relative velocity along every edge
      const E = b.geo.edges, ne = E.length >> 1, w = b.w;
      for (let e = 0; e < ne; e++) {
        const i = E[2 * e], j = E[2 * e + 1];
        const wi = w[i], wj = w[j], ws = wi + wj;
        if (ws === 0) continue;
        const i3 = 3 * i, j3 = 3 * j;
        const dx = x[j3] - x[i3], dy = x[j3 + 1] - x[i3 + 1], dz = x[j3 + 2] - x[i3 + 2];
        const l2 = dx * dx + dy * dy + dz * dz;
        if (l2 < 1e-18) continue;
        const rv = (v[j3] - v[i3]) * dx + (v[j3 + 1] - v[i3 + 1]) * dy + (v[j3 + 2] - v[i3 + 2]) * dz;
        const k = (beta * rv) / (l2 * ws);
        v[i3] += wi * k * dx; v[i3 + 1] += wi * k * dy; v[i3 + 2] += wi * k * dz;
        v[j3] -= wj * k * dx; v[j3 + 1] -= wj * k * dy; v[j3 + 2] -= wj * k * dz;
      }
    }
  }

  // ------------------------------------------------------------------ grab
  beginGrab(body, point) {
    if (!body || this.bodies.indexOf(body) < 0 || !point) return false;
    const px = +point[0], py = +point[1], pz = +point[2];
    if (!Number.isFinite(px + py + pz)) return false;
    const x = body.x;
    const idx = [], wt = [];
    let nearest = -1, nd = Infinity;
    for (let i = 0; i < body.n; i++) {
      const d = Math.hypot(x[3 * i] - px, x[3 * i + 1] - py, x[3 * i + 2] - pz);
      if (d < nd) { nd = d; nearest = i; }
      if (d < TUNING.grabRadius) {
        const f = d / TUNING.grabRadius;
        idx.push(i);
        wt.push(1 - 0.75 * f * f);
      }
    }
    if (!idx.length) {
      if (nearest < 0 || nd > 3) return false;
      idx.push(nearest);
      wt.push(1);
    }
    const ws = wt.reduce((a, b) => a + b, 0);
    const off = new Float32Array(3 * idx.length);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      off[3 * k] = x[3 * i] - px; off[3 * k + 1] = x[3 * i + 1] - py; off[3 * k + 2] = x[3 * i + 2] - pz;
    }
    this.grab = {
      body,
      anchor: [px, py, pz],
      point: [px, py, pz],
      eff: [px, py, pz], // effective (speed/acceleration-limited, reach-bounded) anchor used by the solver
      effV: [0, 0, 0],   // its velocity (cm/s)
      minY: py - TUNING.grabPressDepth, // the effective anchor never goes lower than this
      idx: Int32Array.from(idx),
      wt: Float32Array.from(wt, (q) => q / ws),
      off,
    };
    return true;
  }

  moveGrab(target) {
    const g = this.grab;
    if (!g || !target) return;
    const tx = +target[0], ty = +target[1], tz = +target[2];
    if (!Number.isFinite(tx + ty + tz)) return;
    g.anchor[0] = tx; g.anchor[1] = ty; g.anchor[2] = tz;
  }

  endGrab() {
    this.grab = null;
  }

  _solveGrab() {
    const g = this.grab, b = g.body, x = b.x, w = b.w;
    const idx = g.idx, wt = g.wt, off = g.off, k = idx.length;
    let cx = 0, cy = 0, cz = 0;
    for (let q = 0; q < k; q++) {
      const i3 = 3 * idx[q];
      cx += wt[q] * (x[i3] - off[3 * q]);
      cy += wt[q] * (x[i3 + 1] - off[3 * q + 1]);
      cz += wt[q] * (x[i3 + 2] - off[3 * q + 2]);
    }
    g.point[0] = cx; g.point[1] = cy; g.point[2] = cz;
    const box = WALL - TUNING.grabRadius - 2;
    let ax = Math.min(box, Math.max(-box, g.anchor[0]));
    let ay = Math.min(TUNING.grabMaxHeight, Math.max(0.2, g.minY, g.anchor[1]));
    let az = Math.min(box, Math.max(-box, g.anchor[2]));
    // The effective anchor "arrives" at the requested one: speed <= grabMaxSpeed, acceleration <= grabMaxAccel,
    // braking so it stops on the target. A sudden far-away target therefore tugs the jelly along instead of
    // yanking it (an instant 150 cm/s start pinned the chin by friction, stretched the body to the strain limit
    // and whipped the tail off the mat at ~450 cm/s).
    const e = g.eff, ev = g.effV, amax = TUNING.grabMaxAccel;
    let mx = ax - e[0], my = ay - e[1], mz = az - e[2];
    const ml = Math.sqrt(mx * mx + my * my + mz * mz);
    let wx = 0, wy = 0, wz = 0;
    if (ml > 1e-9) {
      const sp = Math.min(TUNING.grabMaxSpeed, Math.sqrt(2 * amax * ml), ml / H) / ml;
      wx = mx * sp; wy = my * sp; wz = mz * sp;
    }
    let qx = wx - ev[0], qy = wy - ev[1], qz = wz - ev[2];
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz), dvmax = amax * H;
    if (ql > dvmax) { const s = dvmax / ql; qx *= s; qy *= s; qz *= s; }
    ev[0] += qx; ev[1] += qy; ev[2] += qz;
    e[0] += ev[0] * H; e[1] += ev[1] * H; e[2] += ev[2] * H;
    ax = e[0]; ay = e[1]; az = e[2];
    // bounded reach: never more than grabReach from the grabbed point (bounds the pulling force); while it
    // waits for the body the anchor drops its outward velocity, so it re-accelerates gently afterwards
    let dx = ax - cx, dy = ay - cy, dz = az - cz;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl > TUNING.grabReach) {
      const s = TUNING.grabReach / dl;
      ax = cx + dx * s; ay = cy + dy * s; az = cz + dz * s;
      e[0] = ax; e[1] = ay; e[2] = az;
      const ux = dx / dl, uy = dy / dl, uz = dz / dl;
      const out = ev[0] * ux + ev[1] * uy + ev[2] * uz;
      if (out > 0) { ev[0] -= out * ux; ev[1] -= out * uy; ev[2] -= out * uz; }
    }
    const alpha = 1 / (TUNING.grabStiffness * H * H);
    for (let q = 0; q < k; q++) {
      const i = idx[q], i3 = 3 * i;
      const tx = ax + off[3 * q] - x[i3], ty = ay + off[3 * q + 1] - x[i3 + 1], tz = az + off[3 * q + 2] - x[i3 + 2];
      const wi = w[i];
      if (wi === 0) continue;
      const f = wi / (wi + alpha / wt[q]);
      x[i3] += tx * f; x[i3 + 1] += ty * f; x[i3 + 2] += tz * f;
    }
  }

  // ------------------------------------------------------------------ impulses
  poke(body, point, dir, speed = 90) {
    if (!body || this.bodies.indexOf(body) < 0 || !point || !dir) return;
    let dx = +dir[0], dy = +dir[1], dz = +dir[2];
    const dl = Math.hypot(dx, dy, dz);
    if (!(dl > 1e-9) || !Number.isFinite(speed)) return;
    dx /= dl; dy /= dl; dz /= dl;
    const x = body.x, v = body.v;
    for (let i = 0; i < body.n; i++) {
      const d = Math.hypot(x[3 * i] - point[0], x[3 * i + 1] - point[1], x[3 * i + 2] - point[2]);
      if (d >= TUNING.pokeRadius) continue;
      const f = (1 - d / TUNING.pokeRadius) ** 2 * speed;
      v[3 * i] += dx * f; v[3 * i + 1] += dy * f; v[3 * i + 2] += dz * f;
    }
  }

  // The impulse is applied at the start of the next step() that advances time, so presses while paused (or
  // several in one frame) count once. It tops each piece's mean upward speed up to nudgeSpeed instead of adding
  // to it, and presses within nudgeCooldown of the last applied nudge are ignored, so repeated presses can't
  // stack into a launch.
  nudge() {
    if (this.bodies.length) this._nudgePending = true;
  }

  _applyNudge() {
    this._nudgePending = false;
    if (this.time - this._lastNudge < TUNING.nudgeCooldown) return;
    this._lastNudge = this.time;
    const k = this._nudges++;
    const c = [0, 0, 0];
    const up0 = TUNING.nudgeSpeed;
    this.bodies.forEach((b, bi) => {
      b.centroid(c);
      const x = b.x, v = b.v, ms = b.mass;
      let vy = 0;
      for (let i = 0; i < b.n; i++) vy += ms[i] * v[3 * i + 1];
      vy /= b.totalMass || 1;
      const up = Math.max(0, up0 - Math.max(0, vy));
      if (!(up > 1e-3)) return;
      const s = up / up0;                                      // a piece already rising gets less of the rest
      const ang = k * 2.39996 + bi * 1.3;
      const sx = Math.cos(ang) * 9 * s, sz = Math.sin(ang) * 9 * s;
      const spin = ((k + bi) % 2 ? 1 : -1) * 1.1 * s;         // about world y (rad/s)
      const tilt = Math.sin(k * 1.7 + bi * 0.9) * 0.9 * s;     // about world x (rad/s)
      for (let i = 0; i < b.n; i++) {
        const rx = x[3 * i] - c[0], ry = x[3 * i + 1] - c[1], rz = x[3 * i + 2] - c[2];
        // omega x r with omega = (tilt, spin, 0)
        v[3 * i] += sx + spin * rz;
        v[3 * i + 1] += up - tilt * rz;
        v[3 * i + 2] += sz - spin * rx + tilt * ry;
      }
    });
  }

  // ------------------------------------------------------------------ inter-body contact
  // Vertex-face contact between the tet-mesh boundaries of different pieces, every substep:
  //  - broad phase: each pair of bodies whose boxes come within contactSearch of each other adds its overlap
  //    region to both bodies' regions of interest;
  //  - the outward boundary faces of each body that meet its region are hashed into a uniform grid;
  //  - each boundary particle inside its body's region finds, per other body, the nearest face within
  //    contactSearch. If it is closer than contactSkin to that face, or behind it (inside the other body), it is
  //    projected out along the face's outward normal to contactSkin, the correction shared with the face's three
  //    vertices by inverse mass and barycentric weight. The push is one-sided (it never flips once a particle is
  //    inside) and is followed by position-based friction on the relative tangential slip of that substep.
  // Faces lying on the mat and facing down are skipped: nothing can reach them from below, and a particle on the
  // mat inside another piece's footprint would otherwise be pushed into the floor instead of out sideways.
  _ensureScratch() {
    const key = this.version + ':' + this.bodies.length + ':' + (this.bodies[0] ? this.bodies[0].id : 0);
    if (key === this._scratchKey && this._cs) return;
    this._scratchKey = key;
    const nb = this.bodies.length;
    let nf = 0;
    for (const b of this.bodies) nf += b.boundaryFaces.length / 3;
    let ts = 256;
    while (ts < 4 * nf) ts <<= 1;
    const cap = 8 * nf + 64;
    const np = Math.max(1, (nb * (nb - 1)) >> 1);
    this._cs = {
      box: new Float64Array(6 * nb),     // world bounding box per body
      pairBox: new Float64Array(6 * np), // overlap of two bodies' boxes, grown by contactSearch
      pairA: new Int32Array(np), pairB: new Int32Array(np),
      adjStart: new Int32Array(nb + 1), adj: new Int32Array(2 * np), adjFill: new Int32Array(nb),
      fBody: new Int32Array(nf), fFace: new Int32Array(nf), fN: new Float64Array(3 * nf), seen: new Int32Array(nf),
      fBox: new Float64Array(6 * nf),
      cellOf: new Int32Array(cap), ent: new Int32Array(cap), sorted: new Int32Array(cap),
      start: new Int32Array(ts + 1), mask: ts - 1,
      bestD: new Float64Array(nb), bestS: new Float64Array(nb), bestK: new Int32Array(nb).fill(-1),
      bestU: new Float64Array(3 * nb), touched: new Int32Array(nb),
      crossK: new Int32Array(nb).fill(-1), crossD: new Float64Array(nb), crossS: new Float64Array(nb), crossU: new Float64Array(3 * nb),
      bary: new Float64Array(3), query: 0,
    };
  }

  _growContact(need) {
    const cs = this._cs;
    let cap = cs.cellOf.length;
    while (cap <= need) cap *= 2;
    const grow = (a) => { const b = new Int32Array(cap); b.set(a); return b; };
    cs.cellOf = grow(cs.cellOf);
    cs.ent = grow(cs.ent);
    cs.sorted = new Int32Array(cap);
  }

  _collide() {
    const bodies = this.bodies, nb = bodies.length, cs = this._cs;
    const skin = TUNING.contactSkin, Rs = TUNING.contactSearch, R2 = Rs * Rs, inv = 1 / TUNING.contactCell;
    const maxPush = TUNING.contactMaxPush, muS = TUNING.contactMuStatic, muK = TUNING.contactMuKinetic;
    const floorY = skin + 0.05;
    const box = cs.box, pairBox = cs.pairBox, pairA = cs.pairA, pairB = cs.pairB;
    const adjStart = cs.adjStart, adj = cs.adj, adjFill = cs.adjFill;
    // broad phase: body boxes, then the pairs whose boxes come within contactSearch of each other
    for (let bi = 0; bi < nb; bi++) {
      const x = bodies[bi].x, n3 = 3 * bodies[bi].n;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < n3; i += 3) {
        const a = x[i], b = x[i + 1], c = x[i + 2];
        if (a < x0) x0 = a;
        if (a > x1) x1 = a;
        if (b < y0) y0 = b;
        if (b > y1) y1 = b;
        if (c < z0) z0 = c;
        if (c > z1) z1 = c;
      }
      const o = 6 * bi;
      box[o] = x0; box[o + 1] = y0; box[o + 2] = z0; box[o + 3] = x1; box[o + 4] = y1; box[o + 5] = z1;
      adjFill[bi] = 0;
    }
    let npair = 0;
    for (let i = 0; i < nb; i++) {
      const oi = 6 * i;
      for (let j = i + 1; j < nb; j++) {
        const oj = 6 * j;
        if (box[oi] > box[oj + 3] + Rs || box[oj] > box[oi + 3] + Rs || box[oi + 1] > box[oj + 4] + Rs
          || box[oj + 1] > box[oi + 4] + Rs || box[oi + 2] > box[oj + 5] + Rs || box[oj + 2] > box[oi + 5] + Rs) continue;
        const op = 6 * npair;
        for (let a = 0; a < 3; a++) {
          pairBox[op + a] = Math.max(box[oi + a], box[oj + a]) - Rs;
          pairBox[op + a + 3] = Math.min(box[oi + a + 3], box[oj + a + 3]) + Rs;
        }
        pairA[npair] = i; pairB[npair] = j;
        adjFill[i]++; adjFill[j]++;
        npair++;
      }
    }
    if (!npair) return;
    adjStart[0] = 0;
    for (let bi = 0; bi < nb; bi++) { adjStart[bi + 1] = adjStart[bi] + adjFill[bi]; adjFill[bi] = adjStart[bi]; }
    for (let q = 0; q < npair; q++) { adj[adjFill[pairA[q]]++] = q; adj[adjFill[pairB[q]]++] = q; }
    // candidate faces: the boundary faces of each body that meet one of its pair boxes, hashed by (grid cell, body)
    const mask = cs.mask, start = cs.start, fBody = cs.fBody, fFace = cs.fFace, fN = cs.fN, fBox = cs.fBox;
    let nf = 0, ni = 0;
    for (let bi = 0; bi < nb; bi++) {
      const q0 = adjStart[bi], q1 = adjStart[bi + 1];
      if (q0 === q1) continue;
      const F = bodies[bi].boundaryFaces, x = bodies[bi].x, bkey = Math.imul(bi + 1, 1640531513);
      for (let f = 0, fl = F.length; f < fl; f += 3) {
        const a = 3 * F[f], b = 3 * F[f + 1], c = 3 * F[f + 2];
        const ax = x[a], ay = x[a + 1], az = x[a + 2], bx = x[b], by = x[b + 1], bz = x[b + 2], cx = x[c], cy = x[c + 1], cz = x[c + 2];
        const lx = Math.min(ax, bx, cx), hx = Math.max(ax, bx, cx);
        const ly = Math.min(ay, by, cy), hy = Math.max(ay, by, cy);
        const lz = Math.min(az, bz, cz), hz = Math.max(az, bz, cz);
        let meets = false;
        for (let q = q0; q < q1 && !meets; q++) {
          const o = 6 * adj[q];
          meets = !(hx < pairBox[o] || lx > pairBox[o + 3] || hy < pairBox[o + 1] || ly > pairBox[o + 4] || hz < pairBox[o + 2] || lz > pairBox[o + 5]);
        }
        if (!meets) continue;
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl < 1e-12) continue;
        nx /= nl; ny /= nl; nz /= nl;
        if (ny < -0.5 && hy < floorY) continue; // resting on the mat, facing down
        fBody[nf] = bi; fFace[nf] = f;
        fN[3 * nf] = nx; fN[3 * nf + 1] = ny; fN[3 * nf + 2] = nz;
        const ob = 6 * nf;
        fBox[ob] = lx - Rs; fBox[ob + 1] = ly - Rs; fBox[ob + 2] = lz - Rs; fBox[ob + 3] = hx + Rs; fBox[ob + 4] = hy + Rs; fBox[ob + 5] = hz + Rs;
        const ix0 = Math.floor(lx * inv), ix1 = Math.floor(hx * inv);
        const iy0 = Math.floor(ly * inv), iy1 = Math.floor(hy * inv);
        const iz0 = Math.floor(lz * inv), iz1 = Math.floor(hz * inv);
        for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
          if (ni >= cs.cellOf.length) this._growContact(ni);
          cs.cellOf[ni] = (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499) ^ Math.imul(iz, 283923481) ^ bkey) & mask;
          cs.ent[ni] = nf;
          ni++;
        }
        nf++;
      }
    }
    if (!nf) return;
    const cellOf = cs.cellOf, ent = cs.ent, sorted = cs.sorted;
    start.fill(0);
    for (let q = 0; q < ni; q++) start[cellOf[q] + 1]++;
    for (let h = 0; h <= mask; h++) start[h + 1] += start[h];
    for (let q = 0; q < ni; q++) sorted[start[cellOf[q]]++] = ent[q];
    for (let h = mask; h > 0; h--) start[h] = start[h - 1];
    start[0] = 0;
    // narrow phase and projection
    const seen = cs.seen, bestD = cs.bestD, bestS = cs.bestS, bestK = cs.bestK, bestU = cs.bestU, touched = cs.touched, bary = cs.bary;
    const crossK = cs.crossK, crossD = cs.crossD, crossS = cs.crossS, crossU = cs.crossU;
    for (let bi = 0; bi < nb; bi++) {
      const q0 = adjStart[bi], q1 = adjStart[bi + 1];
      if (q0 === q1) continue;
      const b = bodies[bi], idx = b.surfIdx, x = b.x, p = b.p, w = b.w;
      for (let q = 0, ql = idx.length; q < ql; q++) {
        const i = idx[q], i3 = 3 * i, wp = w[i];
        if (wp === 0) continue;
        const px = x[i3], py = x[i3 + 1], pz = x[i3 + 2];
        let qid = 0, nt = 0;
        for (let pq = q0; pq < q1; pq++) {
          const pi = adj[pq], o = 6 * pi;
          if (px < pairBox[o] || px > pairBox[o + 3] || py < pairBox[o + 1] || py > pairBox[o + 4] || pz < pairBox[o + 2] || pz > pairBox[o + 5]) continue;
          const bf = pairA[pi] === bi ? pairB[pi] : pairA[pi];
          const bkey = Math.imul(bf + 1, 1640531513);
          if (!qid) qid = ++cs.query;
          const ox = bodies[bf].x, F = bodies[bf].boundaryFaces;
          const ix0 = Math.floor((px - Rs) * inv), ix1 = Math.floor((px + Rs) * inv);
          const iy0 = Math.floor((py - Rs) * inv), iy1 = Math.floor((py + Rs) * inv);
          const iz0 = Math.floor((pz - Rs) * inv), iz1 = Math.floor((pz + Rs) * inv);
          for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
          const h = (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499) ^ Math.imul(iz, 283923481) ^ bkey) & mask;
          for (let e = start[h], e1 = start[h + 1]; e < e1; e++) {
            const k = sorted[e];
            if (seen[k] === qid) continue;
            seen[k] = qid;
            if (fBody[k] !== bf) continue;               // hash collision with another body or cell
            const ofb = 6 * k;
            if (px < fBox[ofb] || px > fBox[ofb + 3] || py < fBox[ofb + 1] || py > fBox[ofb + 4] || pz < fBox[ofb + 2] || pz > fBox[ofb + 5]) continue;
            const f = fFace[k];
            const a = 3 * F[f], c1 = 3 * F[f + 1], c2 = 3 * F[f + 2];
            closestBary(px, py, pz, ox[a], ox[a + 1], ox[a + 2], ox[c1], ox[c1 + 1], ox[c1 + 2], ox[c2], ox[c2 + 1], ox[c2 + 2], bary);
            const u0 = bary[0], u1 = bary[1], u2 = bary[2];
            const dx = px - (u0 * ox[a] + u1 * ox[c1] + u2 * ox[c2]);
            const dy = py - (u0 * ox[a + 1] + u1 * ox[c1 + 1] + u2 * ox[c2 + 1]);
            const dz = pz - (u0 * ox[a + 2] + u1 * ox[c1 + 2] + u2 * ox[c2 + 2]);
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > R2) continue;
            const fnx = fN[3 * k], fny = fN[3 * k + 1], fnz = fN[3 * k + 2];
            const sd = dx * fnx + dy * fny + dz * fnz;
            if (bestK[bf] < 0) { touched[nt++] = bf; crossK[bf] = -1; }
            // The face the particle crossed this substep: it was in front of it at the start of the substep and
            // sits squarely over (or under) it now. Pushing out through that face, rather than the nearest one,
            // keeps a piece landing near another's rim on top instead of sliding it off sideways.
            if (sd < skin && sd * sd >= 0.9 * d2 && (crossK[bf] < 0 || d2 < crossD[bf])) {
              const op = bodies[bf].p;
              const sp = (p[i3] - (u0 * op[a] + u1 * op[c1] + u2 * op[c2])) * fnx
                + (p[i3 + 1] - (u0 * op[a + 1] + u1 * op[c1 + 1] + u2 * op[c2 + 1])) * fny
                + (p[i3 + 2] - (u0 * op[a + 2] + u1 * op[c1 + 2] + u2 * op[c2 + 2])) * fnz;
              if (sp >= 0) {
                crossK[bf] = k; crossD[bf] = d2; crossS[bf] = sd;
                crossU[3 * bf] = u0; crossU[3 * bf + 1] = u1; crossU[3 * bf + 2] = u2;
              }
            }
            if (bestK[bf] >= 0 && k !== bestK[bf]) {
              // nearest face wins; on a shared edge or vertex (a tie) the face the particle sits squarely in front
              // of or behind wins, which gives the right side at convex edges
              const bd = bestD[bf];
              if (d2 > bd + 1e-8 || (d2 > bd - 1e-8 && Math.abs(sd) <= Math.abs(bestS[bf]))) continue;
            }
            bestK[bf] = k; bestD[bf] = d2; bestS[bf] = sd;
            bestU[3 * bf] = u0; bestU[3 * bf + 1] = u1; bestU[3 * bf + 2] = u2;
          }
          }
        }
        for (let t = 0; t < nt; t++) {
          const bf = touched[t];
          let k = bestK[bf];
          bestK[bf] = -1;
          let sd = bestS[bf];
          if (sd >= skin) continue;                  // the nearest face says it is clear of that piece
          let u0 = bestU[3 * bf], u1 = bestU[3 * bf + 1], u2 = bestU[3 * bf + 2];
          if (crossK[bf] >= 0) {
            k = crossK[bf]; sd = crossS[bf];
            u0 = crossU[3 * bf]; u1 = crossU[3 * bf + 1]; u2 = crossU[3 * bf + 2];
          }
          const ob = bodies[bf], ox = ob.x, op = ob.p, ow = ob.w, F = ob.boundaryFaces, f = fFace[k];
          const ia = F[f], ib = F[f + 1], ic = F[f + 2], a = 3 * ia, c1 = 3 * ib, c2 = 3 * ic;
          const wa = ow[ia] * u0, wb = ow[ib] * u1, wc = ow[ic] * u2;
          const den = wp + wa * u0 + wb * u1 + wc * u2;
          if (den < 1e-12) continue;
          const nx = fN[3 * k], ny = fN[3 * k + 1], nz = fN[3 * k + 2];
          const depth = Math.min(skin - sd, maxPush);
          let lam = depth / den;
          x[i3] += wp * lam * nx; x[i3 + 1] += wp * lam * ny; x[i3 + 2] += wp * lam * nz;
          ox[a] -= wa * lam * nx; ox[a + 1] -= wa * lam * ny; ox[a + 2] -= wa * lam * nz;
          ox[c1] -= wb * lam * nx; ox[c1 + 1] -= wb * lam * ny; ox[c1 + 2] -= wb * lam * nz;
          ox[c2] -= wc * lam * nx; ox[c2 + 1] -= wc * lam * ny; ox[c2 + 2] -= wc * lam * nz;
          // friction on the relative tangential slip over this substep
          const rx = x[i3] - p[i3] - (u0 * (ox[a] - op[a]) + u1 * (ox[c1] - op[c1]) + u2 * (ox[c2] - op[c2]));
          const ry = x[i3 + 1] - p[i3 + 1] - (u0 * (ox[a + 1] - op[a + 1]) + u1 * (ox[c1 + 1] - op[c1 + 1]) + u2 * (ox[c2 + 1] - op[c2 + 1]));
          const rz = x[i3 + 2] - p[i3 + 2] - (u0 * (ox[a + 2] - op[a + 2]) + u1 * (ox[c1 + 2] - op[c1 + 2]) + u2 * (ox[c2 + 2] - op[c2 + 2]));
          const rn = rx * nx + ry * ny + rz * nz;
          const tx = rx - rn * nx, ty = ry - rn * ny, tz = rz - rn * nz;
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (tl > 1e-9) {
            const fr = tl < muS * depth ? 1 : Math.min(1, (muK * depth) / tl);
            lam = -fr / den;
            x[i3] += wp * lam * tx; x[i3 + 1] += wp * lam * ty; x[i3 + 2] += wp * lam * tz;
            ox[a] -= wa * lam * tx; ox[a + 1] -= wa * lam * ty; ox[a + 2] -= wa * lam * tz;
            ox[c1] -= wb * lam * tx; ox[c1 + 1] -= wb * lam * ty; ox[c1 + 2] -= wb * lam * tz;
            ox[c2] -= wc * lam * tx; ox[c2 + 1] -= wc * lam * ty; ox[c2 + 2] -= wc * lam * tz;
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ NaN guard
  _guard() {
    for (const b of this.bodies) {
      const x = b.x, v = b.v;
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i] + v[i];
      if (Number.isFinite(s)) {
        b.centroid(b.lastCentroid);
        continue;
      }
      // rebuild at rest pose (face-up) around the last finite centroid
      const c = b.lastCentroid;
      const cx = Number.isFinite(c[0]) ? c[0] : 0, cy = Number.isFinite(c[1]) ? c[1] : FACE.T, cz = Number.isFinite(c[2]) ? c[2] : 0;
      b.placeFaceUp(0);
      const c2 = b.centroid([0, 0, 0]);
      let minY = Infinity;
      for (let i = 0; i < b.n; i++) minY = Math.min(minY, x[3 * i + 1] - c2[1] + cy);
      const lift = minY < 0 ? -minY : 0;
      for (let i = 0; i < b.n; i++) {
        x[3 * i] += cx - c2[0];
        x[3 * i + 1] += cy - c2[1] + lift;
        x[3 * i + 2] += cz - c2[2];
        x[3 * i] = Math.max(-WALL, Math.min(WALL, x[3 * i]));
        x[3 * i + 2] = Math.max(-WALL, Math.min(WALL, x[3 * i + 2]));
      }
      b.p.set(x);
      b.v.fill(0);
      b.centroid(b.lastCentroid);
      if (this.grab && this.grab.body === b) this.grab = null;
    }
  }

  // ------------------------------------------------------------------ slicing
  slice(plane, accept) {
    const res = { cut: 0, pieces: this.bodies.length, message: '' };
    if (!plane || !plane.n) return res;
    let nx = +plane.n[0], ny = +plane.n[1], nz = +plane.n[2];
    const nl = Math.hypot(nx, ny, nz);
    const d = +plane.d;
    if (!(nl > 1e-9) || !Number.isFinite(d)) return res;
    nx /= nl; ny /= nl; nz /= nl;
    const dd = d / nl;
    const acc = typeof accept === 'function' ? accept : () => true;
    const out = [];
    const messages = [];
    const old = this.bodies;
    for (let bi = 0; bi < old.length; bi++) {
      const body = old[bi];
      const remaining = old.length - bi - 1;
      const r = this._sliceBody(body, nx, ny, nz, dd, acc, out.length + remaining + 1 >= MAX_BODIES);
      if (r && r.pieces) {
        out.push(...r.pieces);
        res.cut++;
        if (this.grab && this.grab.body === body) this.grab = null;
      } else {
        out.push(body);
        if (r && r.message) messages.push(r.message);
      }
    }
    if (res.cut) {
      this.bodies = out;
      this.version++;
    } else if (messages.length) {
      // several pieces crossed and none cut: the most actionable message wins
      res.message = [MSG_PLENTY, MSG_SWIPE, MSG_THIN, MSG_ALONG].find((m) => messages.includes(m)) || messages[0];
    }
    // cut = bodies cut by this call (each becomes two); pieces = bodies in the world afterwards
    res.pieces = this.bodies.length;
    return res;
  }

  _sliceBody(body, nx, ny, nz, d, accept, full) {
    const x = body.x, E = body.geo.edges, P = body.geo.particles, ne = E.length >> 1;
    const W = [], Rr = [];
    for (let e = 0; e < ne; e++) {
      const i = E[2 * e], j = E[2 * e + 1];
      const si = nx * x[3 * i] + ny * x[3 * i + 1] + nz * x[3 * i + 2] - d;
      const sj = nx * x[3 * j] + ny * x[3 * j + 1] + nz * x[3 * j + 2] - d;
      if ((si < 0) === (sj < 0)) continue;
      const t = si / (si - sj);
      for (let c = 0; c < 3; c++) {
        W.push(x[3 * i + c] + (x[3 * j + c] - x[3 * i + c]) * t);
        Rr.push(P[3 * i + c] + (P[3 * j + c] - P[3 * i + c]) * t);
      }
    }
    const k = W.length / 3;
    if (k < 6) return null;
    for (let q = 0; q < k; q++) if (!accept(W[3 * q], W[3 * q + 1], W[3 * q + 2])) return { message: MSG_SWIPE };
    if (full) return { message: MSG_PLENTY };
    // rest-space plane through the crossings (PCA): normal = direction of least spread
    let mx = 0, my = 0, mz = 0;
    for (let q = 0; q < k; q++) { mx += Rr[3 * q]; my += Rr[3 * q + 1]; mz += Rr[3 * q + 2]; }
    mx /= k; my /= k; mz /= k;
    const cov = [0, 0, 0, 0, 0, 0];
    for (let q = 0; q < k; q++) {
      const a = Rr[3 * q] - mx, b = Rr[3 * q + 1] - my, c = Rr[3 * q + 2] - mz;
      cov[0] += a * a; cov[1] += a * b; cov[2] += a * c; cov[3] += b * b; cov[4] += b * c; cov[5] += c * c;
    }
    for (let i = 0; i < 6; i++) cov[i] /= k;
    const eg = eigSym3(cov);
    let lnx, lny;
    if (eg.values[1] > 1e-4 * Math.max(eg.values[0], 1e-12)) {
      const nr = eg.vectors[2];
      if (Math.abs(nr[2]) > 0.94) return { message: MSG_ALONG };
      const hl = Math.hypot(nr[0], nr[1]);
      lnx = nr[0] / hl; lny = nr[1] / hl;
    } else {
      // crossings on a line: use the 2D principal axis
      const sxx = cov[0], sxy = cov[1], syy = cov[3];
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      lnx = -Math.sin(ang); lny = Math.cos(ang);
    }
    // spread of the crossings along the cut line
    let lo = Infinity, hi = -Infinity;
    for (let q = 0; q < k; q++) {
      const s = (Rr[3 * q] - mx) * -lny + (Rr[3 * q + 1] - my) * lnx;
      lo = Math.min(lo, s); hi = Math.max(hi, s);
    }
    if (hi - lo < 1) return { message: MSG_ALONG };
    const halves = splitConvex(body.geo.outline, { px: mx, py: my, nx: lnx, ny: lny });
    const diag = { line: [mx, my, lnx, lny], halves: halves.map((hp) => (hp.length ? polygonArea(hp) : 0)) };
    this.lastReject = diag; // diagnostics only (sandbox scripts): split areas and why the last body was / wasn't cut
    if (!halves[0].length || !halves[1].length) { diag.reason = 'line misses the outline'; return { message: MSG_THIN }; }
    const rounded = [], radii = [];
    const cutLine = { px: mx, py: my, nx: lnx, ny: lny };
    for (const hpoly of halves) {
      const rad = Math.max(TUNING.filletMinRadius, Math.min(FACE.cornerRadius, body.minFillet, cutFilletRadius(hpoly, cutLine)));
      const r = roundPolygon(hpoly, rad);
      const ra = r.length >= 6 ? Math.abs(polygonArea(r)) : 0, ri = ra >= 3 ? inradius(r) : 0;
      if (r.length < 6 || ra < 3 || ri < 0.75) {
        Object.assign(diag, { reason: 'thin piece', radius: rad, area: ra, inradius: ri, rawArea: Math.abs(polygonArea(hpoly)), rawInradius: inradius(hpoly) });
        return { message: MSG_THIN };
      }
      rounded.push(r);
      radii.push(rad);
    }
    const pieces = [];
    for (let q = 0; q < rounded.length; q++) {
      try {
        const pb = new Body(buildPiece(rounded[q], this.relief, { bubbles: this._bubbles }));
        pb.minFillet = radii[q];
        pieces.push(pb);
      } catch (e) {
        this.lastBuildError = e; // diagnostics only: meshing failed for this outline
        diag.reason = 'meshing failed: ' + e.message;
        diag.outline = Array.from(rounded[q]);
        return { message: MSG_THIN };
      }
    }
    diag.reason = 'cut';
    const tm = { particles: body.geo.particles, tets: body.geo.tets };
    for (const pb of pieces) transferEmbedded(body, pb, tm, pb.geo.particles);
    // wedge the pieces apart along the horizontal part of the blade normal
    let hx = nx, hz = nz;
    let hl = Math.hypot(hx, hz);
    const c0 = pieces[0].centroid([0, 0, 0]), c1 = pieces[1].centroid([0, 0, 0]);
    if (hl < 0.2) {
      hx = c1[0] - c0[0]; hz = c1[2] - c0[2];
      hl = Math.hypot(hx, hz);
      if (hl < 1e-6) { hx = 1; hz = 0; hl = 1; }
    }
    hx /= hl; hz /= hl;
    let s0 = (c0[0] - c1[0]) * hx + (c0[2] - c1[2]) * hz;
    const sign0 = s0 >= 0 ? 1 : -1;
    const pushV = TUNING.wedgeSpeed;
    pieces.forEach((pb, i) => {
      const sg = i === 0 ? sign0 : -sign0;
      const v = pb.v;
      for (let q = 0; q < pb.n; q++) { v[3 * q] += sg * pushV * hx; v[3 * q + 2] += sg * pushV * hz; }
      // The +-10 cm/s impulse alone dies on the mat within ~8 ms (friction), so the knife also slides the
      // pieces apart kinematically until their cut faces are one contact distance apart (see _predict).
      pb.slide = { dx: sg * hx, dz: sg * hz, left: TUNING.cutGap / 2 };
      pb.p.set(pb.x);
      pb.centroid(pb.lastCentroid);
    });
    return { pieces };
  }

  // ------------------------------------------------------------------ readouts
  metrics() {
    let mass = 0, vol = 0, rest = 0, ke = 0, particles = 0, tets = 0;
    for (const b of this.bodies) {
      mass += b.totalMass;
      rest += b.restVolume;
      particles += b.n;
      tets += b.m;
      const x = b.x, v = b.v, T = b.geo.tets;
      for (let t = 0; t < b.m; t++) vol += tetVolume(x, T[4 * t], T[4 * t + 1], T[4 * t + 2], T[4 * t + 3]);
      for (let i = 0; i < b.n; i++) ke += 0.5 * b.mass[i] * (v[3 * i] ** 2 + v[3 * i + 1] ** 2 + v[3 * i + 2] ** 2);
    }
    return {
      massG: mass,
      volumePct: rest > 0 ? (100 * vol) / rest : 100,
      kineticUJ: ke / 10, // 1 uJ = 10 g cm^2 / s^2
      pieces: this.bodies.length,
      particles,
      tets,
    };
  }
}

// Largest fillet radius for the new corners of a half (the vertices on the cut line) such that each corner
// loses at most TUNING.filletMaxLoss of area: loss(r, theta) = r^2 (cot(theta/2) - (pi - theta)/2).
function cutFilletRadius(poly, line) {
  const n = poly.length >> 1;
  const on = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    on[i] = Math.abs((poly[2 * i] - line.px) * line.nx + (poly[2 * i + 1] - line.py) * line.ny) < 1e-6 ? 1 : 0;
  }
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    const prev = (i + n - 1) % n, next = (i + 1) % n;
    if (on[prev] === on[next]) continue;
    const along = on[next] ? next : prev;
    const dir = on[next] ? -1 : 1;
    let q = i;
    for (let step = 1; step < n; step++) {
      q = (i + dir * step + n * step) % n;
      if (Math.hypot(poly[2 * q] - poly[2 * i], poly[2 * q + 1] - poly[2 * i + 1]) >= 0.4 || on[q]) break;
    }
    let ux = poly[2 * along] - poly[2 * i], uy = poly[2 * along + 1] - poly[2 * i + 1];
    let vx = poly[2 * q] - poly[2 * i], vy = poly[2 * q + 1] - poly[2 * i + 1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-9 || lv < 1e-9) continue;
    const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
    const th = Math.acos(c);
    const f = 1 / Math.tan(th / 2) - (Math.PI - th) / 2;
    if (f > 1e-9) best = Math.min(best, Math.sqrt(TUNING.filletMaxLoss / f));
  }
  return best;
}

// x, v of `nb` from `old` through barycentric embedding of nb's rest particles in old's rest tet mesh
function transferEmbedded(old, nb, tetMesh, restPts) {
  const emb = embedPoints(tetMesh, restPts);
  const T = old.geo.tets, ox = old.x, ov = old.v;
  for (let q = 0; q < nb.n; q++) {
    const t = 4 * emb.tetOf[q];
    for (let c = 0; c < 3; c++) {
      let xs = 0, vs = 0;
      for (let r = 0; r < 4; r++) {
        const wgt = emb.bary[4 * q + r], i = 3 * T[t + r] + c;
        xs += wgt * ox[i];
        vs += wgt * ov[i];
      }
      nb.x[3 * q + c] = xs;
      nb.v[3 * q + c] = vs;
    }
  }
  for (let q = 0; q < nb.n; q++) if (nb.x[3 * q + 1] < 0) nb.x[3 * q + 1] = 0;
  nb.p.set(nb.x);
}

// Same outline, new relief: the 2D meshes match column for column, so every column keeps its bottom particle
// and is stretched along its current (deformed) direction by the ratio of new to old rest height.
function transferRemold(old, nb) {
  const go = old.geo, gn = nb.geo;
  let same = go.cols === gn.cols && go.layers === gn.layers && old.n === nb.n;
  if (same) {
    for (let i = 0; i < go.cols; i++) {
      if (Math.abs(go.particles[3 * i] - gn.particles[3 * i]) > 1e-5 || Math.abs(go.particles[3 * i + 1] - gn.particles[3 * i + 1]) > 1e-5) { same = false; break; }
    }
  }
  if (same) {
    const cols = go.cols, L = go.layers, Po = go.particles, Pn = gn.particles;
    const x = old.x;
    for (let i = 0; i < cols; i++) {
      const top = 3 * (L * cols + i), bot = 3 * i;
      const ho = Po[top + 2] - Po[bot + 2], hn = Pn[top + 2] - Pn[bot + 2];
      const r = ho > 1e-6 ? hn / ho : 1;
      for (let k = 0; k <= L; k++) {
        const o = 3 * (k * cols + i);
        for (let c = 0; c < 3; c++) nb.x[o + c] = x[bot + c] + (x[o + c] - x[bot + c]) * r;
      }
    }
    nb.v.set(old.v);
    for (let q = 0; q < nb.n; q++) if (nb.x[3 * q + 1] < 0) nb.x[3 * q + 1] = 0;
    nb.p.set(nb.x);
    return;
  }
  // general case: map each new rest point to the same layer fraction of the old column, then embed
  const T = FACE.T, oldR = old.geo, newR = nb.geo;
  const pts = new Float32Array(nb.n * 3);
  const colsN = newR.cols, L = newR.layers;
  for (let q = 0; q < nb.n; q++) {
    const i = q % colsN, k = Math.floor(q / colsN);
    const f = k / L;
    const topZ = newR.particles[3 * (L * colsN + i) + 2];
    const hN = topZ + T / 2;
    // old height at this xy: approximate from nearest old column
    let best = 0, bd = Infinity;
    for (let c = 0; c < oldR.cols; c++) {
      const dx = oldR.particles[3 * c] - newR.particles[3 * i], dy = oldR.particles[3 * c + 1] - newR.particles[3 * i + 1];
      const dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = c; }
    }
    const hO = oldR.particles[3 * (oldR.layers * oldR.cols + best) + 2] + T / 2;
    pts[3 * q] = newR.particles[3 * q];
    pts[3 * q + 1] = newR.particles[3 * q + 1];
    pts[3 * q + 2] = -T / 2 + f * (hN > 0 ? hO : hN);
  }
  transferEmbedded(old, nb, { particles: oldR.particles, tets: oldR.tets }, pts);
}
