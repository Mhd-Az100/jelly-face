// geom.js -- rest-frame geometry for Jelly Face (no DOM, no three.js; Node-testable).
//
// Rest frame ("face frame"): x -> viewer's right on the face, y -> up (forehead), z -> out of the face.
// Units: cm. The back of the jelly is z = -T/2, the front surface is z = T/2 + R(x, y).
// Delaunator and ClipperLib are read lazily from globalThis (classic <script> globals in the page,
// assigned by the Node tests).

export const FACE = {
  T: 2.6,
  H: 12, W: 9.6,
  box: { x0: -5, x1: 5, y0: -6.25, y1: 6.25 },
  bevel: 0.55,
  cornerRadius: 0.8,
  tetSpacing: 0.9,
  surfSpacing: 0.26,
  layers: 3,
  landmarks: {
    eyeL: [-2.0, 0.6], eyeR: [2.0, 0.6], browY: 1.6, noseBridge: [0, 0.6], noseTip: [0, -1.5],
    mouth: [0, -3.1], mouthHalfW: 1.7, chin: [0, -5.3], cheekL: [-2.6, -1.4], cheekR: [2.6, -1.4],
  },
};

const CLIP_SCALE = 1000;

function delaunatorCtor() {
  const D = globalThis.Delaunator;
  if (!D) throw new Error('Delaunator is not loaded');
  return D;
}
function clipperLib() {
  const C = globalThis.ClipperLib;
  if (!C) throw new Error('ClipperLib is not loaded');
  return C;
}

// ---------------------------------------------------------------------------------------------
// Egg outline
// x(t) = a cos t (1 + k sin t), y(t) = b sin t. For k < 0.7 the curve is strictly convex; k > 0 puts the
// widest point a little above the centre and narrows the chin.
const EGG_B = 6;
const EGG_K = 0.2;
const EGG_A = (() => {
  let g = 0;
  for (let i = 0; i <= 20000; i++) {
    const t = (i / 20000) * Math.PI - Math.PI / 2;
    g = Math.max(g, Math.cos(t) * (1 + EGG_K * Math.sin(t)));
  }
  return FACE.W / 2 / g;
})();

function eggPoint(t) {
  return [EGG_A * Math.cos(t) * (1 + EGG_K * Math.sin(t)), EGG_B * Math.sin(t)];
}

export function faceOutline(n = 180) {
  n = Math.max(8, n | 0);
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const [x, y] = eggPoint((2 * Math.PI * i) / n);
    out[2 * i] = x;
    out[2 * i + 1] = y;
  }
  return out;
}

// Normalized egg radius: rho = |p| / r_outline(angle of p). Table over the polar angle.
const RHO_N = 2048;
let rhoTable = null;
function buildRhoTable() {
  const S = 8192;
  const ang = new Float64Array(S), rad = new Float64Array(S);
  for (let i = 0; i < S; i++) {
    const [x, y] = eggPoint((2 * Math.PI * i) / S);
    ang[i] = Math.atan2(y, x);
    rad[i] = Math.hypot(x, y);
  }
  // Rotate so the sequence of angles is increasing from -pi.
  let start = 0;
  for (let i = 1; i < S; i++) if (ang[i] < ang[start]) start = i;
  const A = new Float64Array(S + 2), R = new Float64Array(S + 2);
  for (let i = 0; i < S; i++) {
    A[i + 1] = ang[(start + i) % S];
    R[i + 1] = rad[(start + i) % S];
  }
  A[0] = A[S] - 2 * Math.PI; R[0] = R[S];
  A[S + 1] = A[1] + 2 * Math.PI; R[S + 1] = R[1];
  const tab = new Float64Array(RHO_N + 1);
  let j = 0;
  for (let i = 0; i <= RHO_N; i++) {
    const phi = -Math.PI + (2 * Math.PI * i) / RHO_N;
    while (j < S && A[j + 1] < phi) j++;
    const f = (phi - A[j]) / (A[j + 1] - A[j] || 1);
    tab[i] = R[j] + (R[j + 1] - R[j]) * f;
  }
  rhoTable = tab;
}

function eggRho(x, y) {
  if (!rhoTable) buildRhoTable();
  const r = Math.sqrt(x * x + y * y);
  if (r < 1e-12) return 0;
  const u = ((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * RHO_N;
  let i = Math.floor(u);
  if (i < 0) i = 0;
  if (i >= RHO_N) i = RHO_N - 1;
  const f = u - i;
  return r / (rhoTable[i] + (rhoTable[i + 1] - rhoTable[i]) * f);
}

function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------
// Relief

function gauss(dx, dy, sx, sy) {
  return Math.exp(-0.5 * ((dx * dx) / (sx * sx) + (dy * dy) / (sy * sy)));
}

function sculpt(x, y, rho) {
  const L = FACE.landmarks;
  // broad dome
  let h = 0.5 * (1 - rho * rho);
  // nose ridge: capsule from the bridge to the tip, rising toward the tip
  const bx = L.noseBridge[0], by = L.noseBridge[1], tx = L.noseTip[0], ty = L.noseTip[1];
  const vx = tx - bx, vy = ty - by;
  let t = ((x - bx) * vx + (y - by) * vy) / (vx * vx + vy * vy);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = bx + t * vx, cy = by + t * vy;
  const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
  const w = 0.3 + 0.22 * t;
  h += (0.2 + 0.25 * t) * Math.exp(-d2 / (2 * w * w));
  // tip bulb and nostril wings
  h += 0.14 * gauss(x - tx, y - (ty + 0.05), 0.42, 0.36);
  h += 0.16 * (gauss(x - (tx - 0.62), y - (ty + 0.12), 0.3, 0.24) + gauss(x - (tx + 0.62), y - (ty + 0.12), 0.3, 0.24));
  // eye sockets
  h -= 0.3 * (gauss(x - L.eyeL[0], y - L.eyeL[1], 0.85, 0.5) + gauss(x - L.eyeR[0], y - L.eyeR[1], 0.85, 0.5));
  // brow ridge
  h += 0.2 * (gauss(x - (L.eyeL[0] - 0.05), y - L.browY, 1.15, 0.33) + gauss(x - (L.eyeR[0] + 0.05), y - L.browY, 1.15, 0.33));
  // cheeks
  h += 0.3 * (gauss(x - L.cheekL[0], y - L.cheekL[1], 1.0, 0.9) + gauss(x - L.cheekR[0], y - L.cheekR[1], 1.0, 0.9));
  // lips with a slight groove between them
  const mx = L.mouth[0], my = L.mouth[1], hw = L.mouthHalfW;
  h += 0.25 * gauss(x - mx, y - (my + 0.24), 0.62 * hw, 0.2);
  h += 0.25 * gauss(x - mx, y - (my - 0.3), 0.55 * hw, 0.24);
  h -= 0.08 * gauss(x - mx, y - my, 0.7 * hw, 0.07);
  // chin
  h += 0.3 * gauss(x - L.chin[0], y - (L.chin[1] + 0.8), 1.1, 0.6);
  return h;
}

function sampleLum(lum, x, y) {
  const B = FACE.box;
  const w = lum.w, h = lum.h, d = lum.data;
  let u = ((x - B.x0) / (B.x1 - B.x0)) * w - 0.5;
  let v = ((B.y1 - y) / (B.y1 - B.y0)) * h - 0.5;
  u = u < 0 ? 0 : u > w - 1 ? w - 1 : u;
  v = v < 0 ? 0 : v > h - 1 ? h - 1 : v;
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const i1 = i0 + 1 < w ? i0 + 1 : i0, j1 = j0 + 1 < h ? j0 + 1 : j0;
  const fu = u - i0, fv = v - j0;
  const a = d[j0 * w + i0], b = d[j0 * w + i1], c = d[j1 * w + i0], e = d[j1 * w + i1];
  return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv;
}

export function makeRelief({ depth = 1, emboss = 0.3, lum = null } = {}) {
  depth = Number.isFinite(depth) ? Math.max(0, depth) : 1;
  emboss = Number.isFinite(emboss) ? Math.max(0, emboss) : 0;
  const useLum = !!(lum && lum.data && lum.w > 0 && lum.h > 0 && emboss > 0);
  let mean = 0;
  if (useLum) {
    const B = FACE.box;
    let s = 0, c = 0;
    for (let j = 0; j < lum.h; j++) {
      const y = B.y1 - ((j + 0.5) / lum.h) * (B.y1 - B.y0);
      for (let i = 0; i < lum.w; i++) {
        const x = B.x0 + ((i + 0.5) / lum.w) * (B.x1 - B.x0);
        if (eggRho(x, y) < 1) { s += lum.data[j * lum.w + i]; c++; }
      }
    }
    if (c === 0) for (let i = 0; i < lum.data.length; i++) { s += lum.data[i]; c++; }
    mean = c ? s / c : 0;
  }
  const k = emboss * 0.35;
  const relief = (x, y) => {
    const rho = eggRho(x, y);
    if (!(rho < 1)) return 0;
    // x smoothstep(0, 0.3, 1 - rho), starting at 0.002 so the rim is exactly 0 despite table interpolation
    const taper = smoothstep(0.002, 0.3, 1 - rho);
    if (taper === 0) return 0;
    let r = depth * sculpt(x, y, rho);
    if (useLum) r += k * (sampleLum(lum, x, y) - mean);
    r *= taper;
    return r < -0.45 ? -0.45 : r > 1.8 ? 1.8 : r;
  };
  relief.depth = depth;
  relief.emboss = emboss;
  return relief;
}

// ---------------------------------------------------------------------------------------------
// Polygon helpers. Polygons are flat [x0, y0, x1, y1, ...] arrays (Float64Array preferred), closed implicitly.

export function polygonArea(poly) {
  const n = poly.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += poly[2 * j] * poly[2 * i + 1] - poly[2 * i] * poly[2 * j + 1];
  return 0.5 * a; // signed: > 0 for CCW
}

export function pointInPolygon(poly, x, y) {
  const n = poly.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToPolygon(poly, x, y) {
  const n = poly.length >> 1;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[2 * j], ay = poly[2 * j + 1], bx = poly[2 * i], by = poly[2 * i + 1];
    const ex = bx - ax, ey = by - ay;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + t * ex - x, dy = ay + t * ey - y;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function ensureCCW(poly) {
  const out = Float64Array.from(poly);
  if (polygonArea(out) < 0) {
    const n = out.length >> 1;
    for (let i = 0; i < n >> 1; i++) {
      const j = n - 1 - i;
      const tx = out[2 * i], ty = out[2 * i + 1];
      out[2 * i] = out[2 * j]; out[2 * i + 1] = out[2 * j + 1];
      out[2 * j] = tx; out[2 * j + 1] = ty;
    }
  }
  return out;
}

function dedupePolygon(poly, eps = 1e-7) {
  const n = poly.length >> 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = poly[2 * i], y = poly[2 * i + 1];
    const m = out.length;
    if (m >= 2 && Math.abs(out[m - 2] - x) < eps && Math.abs(out[m - 1] - y) < eps) continue;
    out.push(x, y);
  }
  while (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < eps && Math.abs(out[1] - out[out.length - 1]) < eps) out.length -= 2;
  return Float64Array.from(out);
}

// Resample a closed polygon. Default: uniform arc-length spacing (<= spacing). With { tol > 0 } the spacing
// adapts to curvature so the chord sagitta stays near tol (never below minSpacing), and vertices that turn by
// more than cornerDeg are kept exactly.
export function resamplePolygon(poly, spacing, { tol = 0, minSpacing = spacing * 0.3, cornerDeg = 35 } = {}) {
  const src = dedupePolygon(poly);
  const n = src.length >> 1;
  if (n < 3) return Float64Array.from(src);
  const len = new Float64Array(n);
  let P = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    len[i] = Math.hypot(src[2 * j] - src[2 * i], src[2 * j + 1] - src[2 * i + 1]);
    P += len[i];
  }
  // density (samples per cm) at every vertex
  const dens = new Float64Array(n);
  const corner = new Uint8Array(n);
  const cornerRad = (cornerDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    if (tol <= 0) { dens[i] = 1 / spacing; continue; }
    const h = (i + n - 1) % n, j = (i + 1) % n;
    const ax = src[2 * i] - src[2 * h], ay = src[2 * i + 1] - src[2 * h + 1];
    const bx = src[2 * j] - src[2 * i], by = src[2 * j + 1] - src[2 * i + 1];
    const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    if (turn > cornerRad) corner[i] = 1;
    const r = (0.5 * (len[h] + len[i])) / Math.max(turn, 1e-9);
    const hh = Math.min(spacing, Math.max(minSpacing, Math.sqrt(8 * tol * r)));
    dens[i] = 1 / hh;
  }
  if (tol > 0) {
    // spread high density to neighbours so the transition is gradual
    const tmp = Float64Array.from(dens);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) tmp[i] = Math.max(dens[i], dens[(i + 1) % n], dens[(i + n - 1) % n]);
      dens.set(tmp);
    }
  }
  // chains between corners (or the whole loop starting at vertex 0)
  const starts = [];
  for (let i = 0; i < n; i++) if (corner[i]) starts.push(i);
  const out = [];
  const emitChain = (s0, count) => {
    // walk from vertex s0 along `count` edges
    let D = 0;
    const segD = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const i = (s0 + k) % n, j = (i + 1) % n;
      segD[k] = (len[i] * (dens[i] + dens[j])) / 2;
      D += segD[k];
    }
    const minPts = starts.length ? 1 : 3;
    const N = Math.max(minPts, Math.ceil(D - 1e-9));
    const step = D / N;
    let k = 0, acc = 0;
    for (let q = 0; q < N; q++) {
      const target = q * step;
      while (k < count - 1 && acc + segD[k] < target) { acc += segD[k]; k++; }
      const i = (s0 + k) % n, j = (i + 1) % n;
      let f = segD[k] > 0 ? (target - acc) / segD[k] : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      out.push(src[2 * i] + (src[2 * j] - src[2 * i]) * f, src[2 * i + 1] + (src[2 * j + 1] - src[2 * i + 1]) * f);
    }
  };
  if (!starts.length) emitChain(0, n);
  else {
    for (let c = 0; c < starts.length; c++) {
      const s0 = starts[c], s1 = starts[(c + 1) % starts.length];
      const count = ((s1 - s0 + n - 1) % n) + 1;
      emitChain(s0, count);
    }
  }
  return dedupePolygon(Float64Array.from(out));
}

function toClipperPath(poly) {
  const n = poly.length >> 1;
  const path = [];
  for (let i = 0; i < n; i++) path.push({ X: Math.round(poly[2 * i] * CLIP_SCALE), Y: Math.round(poly[2 * i + 1] * CLIP_SCALE) });
  return path;
}
function fromClipperPath(path) {
  const out = new Float64Array(path.length * 2);
  for (let i = 0; i < path.length; i++) {
    out[2 * i] = path[i].X / CLIP_SCALE;
    out[2 * i + 1] = path[i].Y / CLIP_SCALE;
  }
  return out;
}
function largestPath(CL, paths) {
  let best = null, bestA = 0;
  for (const p of paths) {
    if (p.length < 3) continue;
    const a = Math.abs(CL.Clipper.Area(p));
    if (a > bestA) { bestA = a; best = p; }
  }
  return best;
}

// Morphological opening: inward offset by r (miter joins) then outward by r (round joins). Convex corners get
// fillets of radius r; a convex input stays convex. Returns a CCW polygon resampled at <= 0.1 cm, or an
// empty Float64Array if the polygon is thinner than 2r.
// Convex (or nearly convex: hull area within 0.1 %) input -- every jelly piece -- takes an exact path in floating
// point (openConvex). The ClipperOffset path is kept for other shapes. It must not be used for pieces: its
// 0.001 cm integer grid leaves 1-unit back-steps in the eroded polygon, the round-join offset turns each into a
// crack, and the result came back with V notches (~1 in 9 random cuts), which later cuts then inherited.
export function roundPolygon(poly, radius) {
  const src = ensureCCW(dedupePolygon(poly));
  if (!(radius > 0)) return resamplePolygon(src, 0.1);
  const area = polygonArea(src);
  if (src.length >= 6 && area > 0) {
    const hull = convexHullCCW(src);
    if (hull.length >= 6 && polygonArea(hull) - area <= 1e-3 * area) {
      const o = openConvex(hull, radius);
      return o.length >= 6 ? resamplePolygon(o, 0.1) : new Float64Array(0);
    }
  }
  const CL = clipperLib();
  const d = radius * CLIP_SCALE;
  const co = new CL.ClipperOffset(4, 0.25);
  co.AddPath(toClipperPath(src), CL.JoinType.jtMiter, CL.EndType.etClosedPolygon);
  const shrunk = new CL.Paths();
  co.Execute(shrunk, -d);
  let inner = largestPath(CL, shrunk);
  if (!inner) return new Float64Array(0);
  inner = CL.Clipper.CleanPolygon(inner, 1.5); // drop grid back-steps before the round offset
  if (inner.length < 3) return new Float64Array(0);
  const co2 = new CL.ClipperOffset(4, 0.25);
  co2.AddPath(inner, CL.JoinType.jtRound, CL.EndType.etClosedPolygon);
  const grown = new CL.Paths();
  co2.Execute(grown, d);
  const outer = largestPath(CL, grown);
  if (!outer) return new Float64Array(0);
  const res = ensureCCW(fromClipperPath(outer));
  return resamplePolygon(res, 0.1);
}

// Exact opening of a convex CCW polygon by a disc of radius r: erosion = intersection of the edge half-planes
// moved in by r (successive clipping of a bounding box), dilation = the eroded polygon's edges moved out by r
// joined by arcs of radius r. Returns a CCW Float64Array (arc points <= 0.05 cm apart) or an empty one when
// the polygon is thinner than 2r.
function openConvex(hull, r) {
  const n = hull.length >> 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, hull[2 * i]); x1 = Math.max(x1, hull[2 * i]);
    y0 = Math.min(y0, hull[2 * i + 1]); y1 = Math.max(y1, hull[2 * i + 1]);
  }
  let cur = [x0 - 1, y0 - 1, x1 + 1, y0 - 1, x1 + 1, y1 + 1, x0 - 1, y1 + 1];
  for (let i = 0; i < n && cur.length >= 6; i++) {
    const j = (i + 1) % n;
    const ex = hull[2 * j] - hull[2 * i], ey = hull[2 * j + 1] - hull[2 * i + 1];
    const l = Math.hypot(ex, ey);
    if (l < 1e-12) continue;
    const ux = ey / l, uy = -ex / l, lim = ux * hull[2 * i] + uy * hull[2 * i + 1] - r;
    const next = [], m = cur.length >> 1;
    for (let a = 0; a < m; a++) {
      const b = (a + 1) % m;
      const xa = cur[2 * a], ya = cur[2 * a + 1], xb = cur[2 * b], yb = cur[2 * b + 1];
      const sa = ux * xa + uy * ya - lim, sb = ux * xb + uy * yb - lim;
      if (sa <= 0) next.push(xa, ya);
      if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
        const t = sa / (sa - sb);
        next.push(xa + (xb - xa) * t, ya + (yb - ya) * t);
      }
    }
    cur = next;
  }
  const E = dedupePolygon(Float64Array.from(cur), 1e-9);
  const m = E.length >> 1;
  if (m < 3 || polygonArea(E) < 1e-9) return new Float64Array(0);
  const out = [];
  for (let i = 0; i < m; i++) {
    const h = (i + m - 1) % m, j = (i + 1) % m;
    // outward normal angles of the edges h -> i and i -> j (CCW: normal of (dx, dy) is (dy, -dx))
    const a0 = Math.atan2(-(E[2 * i] - E[2 * h]), E[2 * i + 1] - E[2 * h + 1]);
    let da = Math.atan2(-(E[2 * j] - E[2 * i]), E[2 * j + 1] - E[2 * i + 1]) - a0;
    while (da < 0) da += 2 * Math.PI;
    while (da >= 2 * Math.PI) da -= 2 * Math.PI;
    if (da > Math.PI) da = 0; // numerically reflex (should not happen): no arc
    const steps = Math.max(1, Math.ceil((da * r) / 0.05));
    for (let s = 0; s <= steps; s++) {
      const th = a0 + (da * s) / steps;
      out.push(E[2 * i] + r * Math.cos(th), E[2 * i + 1] + r * Math.sin(th));
    }
  }
  return dedupePolygon(Float64Array.from(out), 1e-9);
}

// Exact half-plane clip of a convex polygon by the line through (px, py) with normal (nx, ny).
// Returns [negSide, posSide]: points with (p - p0) . n <= 0 and >= 0. Either may be an empty Float64Array.
export function splitConvex(poly, line) {
  const n = poly.length >> 1;
  const { px, py, nx, ny } = line;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = (poly[2 * i] - px) * nx + (poly[2 * i + 1] - py) * ny;
  const neg = [], pos = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = poly[2 * i], yi = poly[2 * i + 1];
    if (s[i] <= 0) neg.push(xi, yi);
    if (s[i] >= 0) pos.push(xi, yi);
    if ((s[i] < 0 && s[j] > 0) || (s[i] > 0 && s[j] < 0)) {
      const t = s[i] / (s[i] - s[j]);
      const x = xi + (poly[2 * j] - xi) * t, y = yi + (poly[2 * j + 1] - yi) * t;
      neg.push(x, y);
      pos.push(x, y);
    }
  }
  const fin = (arr) => {
    const p = dedupePolygon(Float64Array.from(arr), 1e-9);
    if (p.length < 6 || Math.abs(polygonArea(p)) < 1e-9) return new Float64Array(0);
    return ensureCCW(p);
  };
  return [fin(neg), fin(pos)];
}

function isConvexCCW(poly) {
  const n = poly.length >> 1;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n, j = (i + 1) % n;
    const cr = (poly[2 * i] - poly[2 * h]) * (poly[2 * j + 1] - poly[2 * i + 1]) - (poly[2 * i + 1] - poly[2 * h + 1]) * (poly[2 * j] - poly[2 * i]);
    if (cr < -1e-9) return false;
  }
  return true;
}

// convex polygon: is the intersection of the half-planes n_k . p <= c_k - r non-empty?
function convexOffsetNonEmpty(nx, ny, c, r, bbox, bufA, bufB) {
  let a = bufA, b = bufB;
  a[0] = bbox[0]; a[1] = bbox[1]; a[2] = bbox[2]; a[3] = bbox[1]; a[4] = bbox[2]; a[5] = bbox[3]; a[6] = bbox[0]; a[7] = bbox[3];
  let m = 4;
  for (let k = 0; k < nx.length; k++) {
    const lim = c[k] - r;
    let out = 0;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const xi = a[2 * i], yi = a[2 * i + 1], xj = a[2 * j], yj = a[2 * j + 1];
      const si = nx[k] * xi + ny[k] * yi - lim, sj = nx[k] * xj + ny[k] * yj - lim;
      if (si <= 0) { b[2 * out] = xi; b[2 * out + 1] = yi; out++; }
      if ((si < 0 && sj > 0) || (si > 0 && sj < 0)) {
        const t = si / (si - sj);
        b[2 * out] = xi + (xj - xi) * t; b[2 * out + 1] = yi + (yj - yi) * t; out++;
      }
    }
    if (out < 3) return false;
    const tmp = a; a = b; b = tmp;
    m = out;
  }
  let area = 0;
  for (let i = 0, j = m - 1; i < m; j = i++) area += a[2 * j] * a[2 * i + 1] - a[2 * i] * a[2 * j + 1];
  return area > 1e-14;
}

// Convex hull (Andrew's monotone chain), CCW, collinear points dropped.
function convexHullCCW(poly) {
  const n = poly.length >> 1;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => poly[2 * a] - poly[2 * b] || poly[2 * a + 1] - poly[2 * b + 1]);
  const cross = (o, a, b) => (poly[2 * a] - poly[2 * o]) * (poly[2 * b + 1] - poly[2 * o + 1]) - (poly[2 * a + 1] - poly[2 * o + 1]) * (poly[2 * b] - poly[2 * o]);
  const lower = [], upper = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  const out = new Float64Array(2 * h.length);
  h.forEach((i, k) => { out[2 * k] = poly[2 * i]; out[2 * k + 1] = poly[2 * i + 1]; });
  return out;
}

// Largest r for which the inward offset is non-empty (~1e-4 cm accurate). Convex polygons use exact half-plane
// clipping; so do nearly convex ones (hull area within 0.1 %: e.g. pieces that went through Clipper's 0.001 cm
// integer grid and picked up microscopic dents), using their hull. Anything else falls back to bisection with
// ClipperOffset (about 30x slower: it used to dominate the cost of slice()).
export function inradius(poly) {
  let src = ensureCCW(dedupePolygon(poly));
  const area = Math.abs(polygonArea(src));
  if (src.length < 6 || area <= 0) return 0;
  let lo = 0, hi = Math.sqrt(area / Math.PI) + 1e-3;
  let convex = isConvexCCW(src);
  if (!convex) {
    const hull = convexHullCCW(src);
    if (hull.length >= 6 && polygonArea(hull) - area <= 1e-3 * area) { src = hull; convex = true; }
  }
  const n = src.length >> 1;
  if (convex) {
    const nx = [], ny = [], c = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = src[2 * j] - src[2 * i], ey = src[2 * j + 1] - src[2 * i + 1];
      const l = Math.hypot(ex, ey);
      x0 = Math.min(x0, src[2 * i]); x1 = Math.max(x1, src[2 * i]);
      y0 = Math.min(y0, src[2 * i + 1]); y1 = Math.max(y1, src[2 * i + 1]);
      if (l < 1e-9) continue;
      const ux = ey / l, uy = -ex / l; // outward normal
      nx.push(ux); ny.push(uy); c.push(ux * src[2 * i] + uy * src[2 * i + 1]);
    }
    const bbox = [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
    const cap = 2 * (nx.length + 8);
    const bufA = new Float64Array(cap), bufB = new Float64Array(cap);
    const NX = Float64Array.from(nx), NY = Float64Array.from(ny), C = Float64Array.from(c);
    while (hi - lo > 1e-4) {
      const mid = 0.5 * (lo + hi);
      if (convexOffsetNonEmpty(NX, NY, C, mid, bbox, bufA, bufB)) lo = mid; else hi = mid;
    }
    return lo;
  }
  const CL = clipperLib();
  const path = toClipperPath(src);
  while (hi - lo > 1e-4) {
    const mid = 0.5 * (lo + hi);
    const co = new CL.ClipperOffset(4, 0.25);
    co.AddPath(path, CL.JoinType.jtMiter, CL.EndType.etClosedPolygon);
    const sol = new CL.Paths();
    co.Execute(sol, -mid * CLIP_SCALE);
    let ok = false;
    for (const p of sol) if (p.length >= 3 && Math.abs(CL.Clipper.Area(p)) > 0) { ok = true; break; }
    if (ok) lo = mid; else hi = mid;
  }
  return lo;
}

function polygonCentroid(poly) {
  const n = poly.length >> 1;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cr = poly[2 * j] * poly[2 * i + 1] - poly[2 * i] * poly[2 * j + 1];
    a += cr;
    cx += (poly[2 * j] + poly[2 * i]) * cr;
    cy += (poly[2 * j + 1] + poly[2 * i + 1]) * cr;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += poly[2 * i]; sy += poly[2 * i + 1]; }
    return [sx / n, sy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// ---------------------------------------------------------------------------------------------
// Bubbles

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeBubbles(seed = 7, count = 16) {
  const rnd = mulberry32(seed * 2654435761 + 12345);
  const T = FACE.T;
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 400) {
    const x = (rnd() * 2 - 1) * 4.4, y = (rnd() * 2 - 1) * 5.6;
    if (eggRho(x, y) > 0.8) continue;
    const r = 0.05 + 0.11 * rnd();
    // keep clear of the back and of the lowest possible front surface (T/2 - 0.45)
    const z0 = -T / 2 + r + 0.3, z1 = T / 2 - 0.45 - r - 0.15;
    const z = z0 + (z1 - z0) * rnd();
    let ok = true;
    for (const b of out) {
      const d = Math.hypot(b.x - x, b.y - y, b.z - z);
      if (d < b.r + r + 0.25) { ok = false; break; }
    }
    if (ok) out.push({ x, y, z, r });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Triangulation of a region bounded by a closed ring (indices 0..nRing-1 of pts, in order) plus interior
// points. Every ring edge must be a Delaunay edge (true when interior points keep >= half the ring spacing
// away from the ring); the outside part of the hull is removed by a flood fill across non-ring edges.
// Returns CCW triangles (Uint32Array) or null if the ring was not recovered (reason left in triFail).
let triFail = '';
function triangulateRegion(pts, nRing) {
  const D = delaunatorCtor();
  const d = new D(pts);
  const tri = d.triangles, he = d.halfedges;
  const nt = tri.length / 3;
  const isRing = (a, b) => a < nRing && b < nRing && (b === (a + 1) % nRing || a === (b + 1) % nRing);
  const out = new Uint8Array(nt);
  const stack = [];
  for (let e = 0; e < tri.length; e++) {
    if (he[e] !== -1) continue;
    const a = tri[e], b = tri[e % 3 === 2 ? e - 2 : e + 1];
    if (isRing(a, b)) continue;
    const t = (e / 3) | 0;
    if (!out[t]) { out[t] = 1; stack.push(t); }
  }
  while (stack.length) {
    const t = stack.pop();
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k, o = he[e];
      if (o === -1) continue;
      const a = tri[e], b = tri[k === 2 ? e - 2 : e + 1];
      if (isRing(a, b)) continue;
      const t2 = (o / 3) | 0;
      if (!out[t2]) { out[t2] = 1; stack.push(t2); }
    }
  }
  // inside triangles, CCW
  const area2 = (a, b, c) => (pts[2 * b] - pts[2 * a]) * (pts[2 * c + 1] - pts[2 * a + 1]) - (pts[2 * b + 1] - pts[2 * a + 1]) * (pts[2 * c] - pts[2 * a]);
  const tl = [];
  for (let t = 0; t < nt; t++) {
    if (out[t]) continue;
    let a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
    if (area2(a, b, c) < 0) { const q = b; b = c; c = q; }
    tl.push(a, b, c);
  }
  // Nearly collinear ring points (straight cut edges) can leave flat triangles, because Delaunator's in-circle
  // test is not robust. Repair them by flipping the long edge of each flat triangle with its neighbour.
  let scale = 0;
  for (let i = 0; i < pts.length; i++) scale = Math.max(scale, Math.abs(pts[i]));
  const flatEps = 1e-9 * Math.max(1, scale * scale);
  let hasFlat = false;
  for (let t = 0; t < tl.length; t += 3) if (Math.abs(area2(tl[t], tl[t + 1], tl[t + 2])) <= flatEps) { hasFlat = true; break; }
  if (hasFlat && !repairFlat(tl, area2, flatEps, pts)) { triFail = 'flat triangle repair failed'; return null; }
  const ringUse = new Uint8Array(nRing);
  const npts = pts.length >> 1;
  const used = new Uint8Array(npts);
  for (let t = 0; t < tl.length; t += 3) {
    const a = tl[t], b = tl[t + 1], c = tl[t + 2];
    if (!(area2(a, b, c) > flatEps)) { triFail = 'flat triangle'; return null; }
    used[a] = used[b] = used[c] = 1;
    // directed ring edge i -> i+1 (CCW ring) must appear in exactly one inside triangle
    if (a < nRing && b === (a + 1) % nRing) ringUse[a]++;
    if (b < nRing && c === (b + 1) % nRing) ringUse[b]++;
    if (c < nRing && a === (c + 1) % nRing) ringUse[c]++;
  }
  let bad = 0, unused = 0;
  for (let i = 0; i < nRing; i++) if (ringUse[i] !== 1) bad++;
  for (let i = 0; i < npts; i++) if (!used[i]) unused++;
  if (bad || unused) { triFail = `${bad} ring edges not recovered, ${unused} unused points`; return null; }
  return Uint32Array.from(tl);
}

function repairFlat(tl, area2, eps, pts) {
  const npts = pts.length >> 1;
  const dist2 = (u, v) => (pts[2 * u] - pts[2 * v]) ** 2 + (pts[2 * u + 1] - pts[2 * v + 1]) ** 2;
  const key = (u, v) => (u < v ? u * npts + v : v * npts + u);
  const map = new Map();
  const addTri = (t) => {
    for (let k = 0; k < 3; k++) {
      const kk = key(tl[t + k], tl[t + ((k + 1) % 3)]);
      const e = map.get(kk);
      if (e) e.push(t); else map.set(kk, [t]);
    }
  };
  const delTri = (t) => {
    for (let k = 0; k < 3; k++) {
      const kk = key(tl[t + k], tl[t + ((k + 1) % 3)]);
      const e = map.get(kk);
      if (!e) continue;
      const i = e.indexOf(t);
      if (i >= 0) e.splice(i, 1);
      if (!e.length) map.delete(kk);
    }
  };
  for (let t = 0; t < tl.length; t += 3) addTri(t);
  for (let iter = 0, changed = true; changed && iter < 64; iter++) {
    changed = false;
    for (let t = 0; t < tl.length; t += 3) {
      if (Math.abs(area2(tl[t], tl[t + 1], tl[t + 2])) > eps) continue;
      // the vertex between the other two is opposite the longest edge
      let best = -1, bl = -1;
      for (let k = 0; k < 3; k++) {
        const u = tl[t + ((k + 1) % 3)], v = tl[t + ((k + 2) % 3)];
        const l = dist2(u, v);
        if (l > bl) { bl = l; best = k; }
      }
      const b = tl[t + best], a = tl[t + ((best + 1) % 3)], c = tl[t + ((best + 2) % 3)];
      const nb = (map.get(key(a, c)) || []).filter((q) => q !== t);
      if (!nb.length) return false;
      const t2 = nb[0];
      let d = -1;
      for (let k = 0; k < 3; k++) { const v = tl[t2 + k]; if (v !== a && v !== c) d = v; }
      if (d < 0) return false;
      delTri(t); delTri(t2);
      let p = [a, b, d], q = [b, c, d];
      if (area2(p[0], p[1], p[2]) < 0) p = [p[0], p[2], p[1]];
      if (area2(q[0], q[1], q[2]) < 0) q = [q[0], q[2], q[1]];
      tl[t] = p[0]; tl[t + 1] = p[1]; tl[t + 2] = p[2];
      tl[t2] = q[0]; tl[t2 + 1] = q[1]; tl[t2 + 2] = q[2];
      addTri(t); addTri(t2);
      changed = true;
    }
  }
  return true;
}

function latticeInside(poly, s, margin) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, poly[2 * i]); x1 = Math.max(x1, poly[2 * i]);
    y0 = Math.min(y0, poly[2 * i + 1]); y1 = Math.max(y1, poly[2 * i + 1]);
  }
  const [cx, cy] = polygonCentroid(poly);
  const dy = (s * Math.sqrt(3)) / 2;
  const out = [];
  const j0 = Math.floor((y0 - cy) / dy) - 1, j1 = Math.ceil((y1 - cy) / dy) + 1;
  const i0 = Math.floor((x0 - cx) / s) - 2, i1 = Math.ceil((x1 - cx) / s) + 2;
  for (let j = j0; j <= j1; j++) {
    const y = cy + j * dy;
    if (y <= y0 || y >= y1) continue;
    const off = (j & 1) ? s / 2 : 0;
    for (let i = i0; i <= i1; i++) {
      const x = cx + i * s + off;
      if (x <= x0 || x >= x1) continue;
      if (!pointInPolygon(poly, x, y)) continue;
      if (distanceToPolygon(poly, x, y) < margin) continue;
      out.push(x, y);
    }
  }
  return out;
}

// ring + interior lattice -> triangles, retrying with a wider margin if the ring edges were not all recovered
function meshPolygon(ring, spacing, what = 'outline') {
  const nRing = ring.length >> 1;
  const reasons = [];
  for (const mf of [0.52, 0.62, 0.75, 0.9]) {
    let inner = latticeInside(ring, spacing, mf * spacing);
    if (!inner.length) {
      const [cx, cy] = polygonCentroid(ring);
      if (pointInPolygon(ring, cx, cy) && distanceToPolygon(ring, cx, cy) > 0.25 * spacing) inner = [cx, cy];
    }
    const pts = new Float64Array(ring.length + inner.length);
    pts.set(ring, 0);
    pts.set(inner, ring.length);
    const tris = triangulateRegion(pts, nRing);
    if (tris) return { pts, tris };
    reasons.push(triFail);
  }
  // last resort: ring only
  const tris = triangulateRegion(Float64Array.from(ring), nRing);
  if (tris) return { pts: Float64Array.from(ring), tris };
  reasons.push(triFail);
  throw new Error(`buildPiece: could not triangulate ${what} (${nRing} ring points: ${reasons.join('; ')})`);
}

// ---------------------------------------------------------------------------------------------
// Embedding

// Returns { tetOf, bary }. For each point: the tet whose smallest barycentric coordinate is largest (so a point
// inside some tet gets exact weights; a point slightly outside extrapolates from the nearest tet). Points more
// than ~EMBED_LIMIT outside are pulled toward that tet's centroid (every weight >= -EMBED_LIMIT).
const EMBED_LIMIT = 0.6;

export function embedPoints(tetMesh, points) {
  const P = tetMesh.particles, T = tetMesh.tets;
  const m = T.length >> 2, k = (points.length / 3) | 0;
  const tetOf = new Uint32Array(k), bary = new Float32Array(4 * k);
  if (m === 0 || k === 0) return { tetOf, bary };
  const inv = new Float64Array(12 * m);
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  let vsum = 0;
  const tb = new Float32Array(6 * m);
  for (let t = 0; t < m; t++) {
    const a = 3 * T[4 * t], b = 3 * T[4 * t + 1], c = 3 * T[4 * t + 2], d = 3 * T[4 * t + 3];
    const x0 = P[a], y0 = P[a + 1], z0 = P[a + 2];
    const e1x = P[b] - x0, e1y = P[b + 1] - y0, e1z = P[b + 2] - z0;
    const e2x = P[c] - x0, e2y = P[c + 1] - y0, e2z = P[c + 2] - z0;
    const e3x = P[d] - x0, e3y = P[d + 1] - y0, e3z = P[d + 2] - z0;
    // M = [e1 e2 e3] (columns); rows of M^-1 = (e2 x e3, e3 x e1, e1 x e2) / det
    const c1x = e2y * e3z - e2z * e3y, c1y = e2z * e3x - e2x * e3z, c1z = e2x * e3y - e2y * e3x;
    const c2x = e3y * e1z - e3z * e1y, c2y = e3z * e1x - e3x * e1z, c2z = e3x * e1y - e3y * e1x;
    const c3x = e1y * e2z - e1z * e2y, c3y = e1z * e2x - e1x * e2z, c3z = e1x * e2y - e1y * e2x;
    const det = e1x * c1x + e1y * c1y + e1z * c1z;
    const o = 12 * t;
    inv[o] = x0; inv[o + 1] = y0; inv[o + 2] = z0;
    if (Math.abs(det) > 1e-14) {
      const id = 1 / det;
      inv[o + 3] = c1x * id; inv[o + 4] = c1y * id; inv[o + 5] = c1z * id;
      inv[o + 6] = c2x * id; inv[o + 7] = c2y * id; inv[o + 8] = c2z * id;
      inv[o + 9] = c3x * id; inv[o + 10] = c3y * id; inv[o + 11] = c3z * id;
    } else {
      inv[o + 3] = NaN;
    }
    vsum += Math.abs(det) / 6;
    let mnx = x0, mny = y0, mnz = z0, mxx = x0, mxy = y0, mxz = z0;
    for (const q of [b, c, d]) {
      mnx = Math.min(mnx, P[q]); mxx = Math.max(mxx, P[q]);
      mny = Math.min(mny, P[q + 1]); mxy = Math.max(mxy, P[q + 1]);
      mnz = Math.min(mnz, P[q + 2]); mxz = Math.max(mxz, P[q + 2]);
    }
    tb[6 * t] = mnx; tb[6 * t + 1] = mny; tb[6 * t + 2] = mnz;
    tb[6 * t + 3] = mxx; tb[6 * t + 4] = mxy; tb[6 * t + 5] = mxz;
    bx0 = Math.min(bx0, mnx); by0 = Math.min(by0, mny); bz0 = Math.min(bz0, mnz);
    bx1 = Math.max(bx1, mxx); by1 = Math.max(by1, mxy); bz1 = Math.max(bz1, mxz);
  }
  // uniform grid over the tets' bounding box (CSR lists of tets overlapping each cell)
  const cs = Math.max(0.2, 1.4 * Math.cbrt(vsum / m));
  const nx = Math.max(1, Math.min(160, Math.ceil((bx1 - bx0) / cs)));
  const ny = Math.max(1, Math.min(160, Math.ceil((by1 - by0) / cs)));
  const nz = Math.max(1, Math.min(160, Math.ceil((bz1 - bz0) / cs)));
  const sx = (bx1 - bx0) / nx || 1, sy = (by1 - by0) / ny || 1, sz = (bz1 - bz0) / nz || 1;
  const ncell = nx * ny * nz;
  const cnt = new Int32Array(ncell + 1);
  const cellI = (v, v0, s, nn) => { let i = Math.floor((v - v0) / s); return i < 0 ? 0 : i >= nn ? nn - 1 : i; };
  const eps = 1e-4;
  const forCells = (t, fn) => {
    const ia = cellI(tb[6 * t] - eps, bx0, sx, nx), ib = cellI(tb[6 * t + 3] + eps, bx0, sx, nx);
    const ja = cellI(tb[6 * t + 1] - eps, by0, sy, ny), jb = cellI(tb[6 * t + 4] + eps, by0, sy, ny);
    const ka = cellI(tb[6 * t + 2] - eps, bz0, sz, nz), kb = cellI(tb[6 * t + 5] + eps, bz0, sz, nz);
    for (let kk = ka; kk <= kb; kk++) for (let jj = ja; jj <= jb; jj++) for (let ii = ia; ii <= ib; ii++) fn((kk * ny + jj) * nx + ii);
  };
  for (let t = 0; t < m; t++) forCells(t, (c) => cnt[c + 1]++);
  for (let c = 0; c < ncell; c++) cnt[c + 1] += cnt[c];
  const fill = cnt.slice(0, ncell);
  const list = new Int32Array(cnt[ncell]);
  for (let t = 0; t < m; t++) forCells(t, (c) => { list[fill[c]++] = t; });

  let bestT = -1, bestMin = -Infinity, b0 = 0, b1 = 0, b2 = 0, b3 = 0;
  const tryTet = (t, qx, qy, qz) => {
    const o = 12 * t;
    if (inv[o + 3] !== inv[o + 3]) return;
    const dx = qx - inv[o], dy = qy - inv[o + 1], dz = qz - inv[o + 2];
    const u1 = inv[o + 3] * dx + inv[o + 4] * dy + inv[o + 5] * dz;
    const u2 = inv[o + 6] * dx + inv[o + 7] * dy + inv[o + 8] * dz;
    const u3 = inv[o + 9] * dx + inv[o + 10] * dy + inv[o + 11] * dz;
    const u0 = 1 - u1 - u2 - u3;
    const mn = Math.min(u0, u1, u2, u3);
    if (mn > bestMin) { bestMin = mn; bestT = t; b0 = u0; b1 = u1; b2 = u2; b3 = u3; }
  };
  for (let q = 0; q < k; q++) {
    const qx = points[3 * q], qy = points[3 * q + 1], qz = points[3 * q + 2];
    bestT = -1; bestMin = -Infinity;
    const ci = cellI(qx, bx0, sx, nx), cj = cellI(qy, by0, sy, ny), ck = cellI(qz, bz0, sz, nz);
    for (let ring = 0; ring <= 1; ring++) {
      for (let kk = Math.max(0, ck - ring); kk <= Math.min(nz - 1, ck + ring); kk++) {
        for (let jj = Math.max(0, cj - ring); jj <= Math.min(ny - 1, cj + ring); jj++) {
          for (let ii = Math.max(0, ci - ring); ii <= Math.min(nx - 1, ci + ring); ii++) {
            if (ring > 0 && Math.max(Math.abs(kk - ck), Math.abs(jj - cj), Math.abs(ii - ci)) !== ring) continue;
            const c = (kk * ny + jj) * nx + ii;
            for (let e = cnt[c]; e < cnt[c + 1]; e++) tryTet(list[e], qx, qy, qz);
          }
        }
      }
      if (bestMin >= -1e-7) break;
    }
    if (bestMin < -0.25) for (let t = 0; t < m; t++) tryTet(t, qx, qy, qz);
    if (bestT < 0) { bestT = 0; b0 = b1 = b2 = b3 = 0.25; bestMin = 0.25; }
    if (bestMin < -EMBED_LIMIT) {
      const s = (0.25 + EMBED_LIMIT) / (0.25 - bestMin);
      b0 = 0.25 + (b0 - 0.25) * s; b1 = 0.25 + (b1 - 0.25) * s;
      b2 = 0.25 + (b2 - 0.25) * s; b3 = 0.25 + (b3 - 0.25) * s;
    }
    tetOf[q] = bestT;
    bary[4 * q] = b0; bary[4 * q + 1] = b1; bary[4 * q + 2] = b2; bary[4 * q + 3] = b3;
  }
  return { tetOf, bary };
}

// ---------------------------------------------------------------------------------------------
// Piece builder

function tetDet(P, a, b, c, d) {
  const x0 = P[3 * a], y0 = P[3 * a + 1], z0 = P[3 * a + 2];
  const e1x = P[3 * b] - x0, e1y = P[3 * b + 1] - y0, e1z = P[3 * b + 2] - z0;
  const e2x = P[3 * c] - x0, e2y = P[3 * c + 1] - y0, e2z = P[3 * c + 2] - z0;
  const e3x = P[3 * d] - x0, e3y = P[3 * d + 1] - y0, e3z = P[3 * d + 2] - z0;
  return (e1y * e2z - e1z * e2y) * e3x + (e1z * e2x - e1x * e2z) * e3y + (e1x * e2y - e1y * e2x) * e3z;
}

export function buildPiece(outline, relief, { bubbles = [] } = {}) {
  const R = typeof relief === 'function' ? relief : () => 0;
  const T = FACE.T, L = Math.max(1, FACE.layers | 0);
  const ol = ensureCCW(dedupePolygon(outline));
  if (ol.length < 6 || polygonArea(ol) <= 1e-6) throw new Error('buildPiece: empty outline');
  const area = polygonArea(ol);

  // ---- tetrahedral mesh --------------------------------------------------------------------
  const ts = FACE.tetSpacing;
  const bnd = resamplePolygon(ol, ts, { tol: 0.02, minSpacing: 0.3 });
  const nb = bnd.length >> 1;
  const { pts: p2, tris: t2 } = meshPolygon(bnd, ts, 'tet outline');
  const n2 = p2.length >> 1;
  const n = n2 * (L + 1);
  const particles = new Float32Array(3 * n);
  const colH = new Float64Array(n2);
  for (let i = 0; i < n2; i++) colH[i] = T + R(p2[2 * i], p2[2 * i + 1]);
  for (let k = 0; k <= L; k++) {
    for (let i = 0; i < n2; i++) {
      const o = 3 * (k * n2 + i);
      particles[o] = p2[2 * i];
      particles[o + 1] = p2[2 * i + 1];
      particles[o + 2] = -T / 2 + (k / L) * colH[i];
    }
  }
  const ntri = t2.length / 3;
  const m = ntri * 3 * L;
  const tets = new Uint32Array(4 * m);
  let tc = 0;
  const pushTet = (a, b, c, d) => {
    if (tetDet(particles, a, b, c, d) < 0) { const s = c; c = d; d = s; }
    tets[tc++] = a; tets[tc++] = b; tets[tc++] = c; tets[tc++] = d;
  };
  for (let t = 0; t < ntri; t++) {
    let v0 = t2[3 * t], v1 = t2[3 * t + 1], v2 = t2[3 * t + 2];
    // sort by index: the split of every side quad then depends only on its two vertex indices
    if (v0 > v1) { const s = v0; v0 = v1; v1 = s; }
    if (v1 > v2) { const s = v1; v1 = v2; v2 = s; }
    if (v0 > v1) { const s = v0; v0 = v1; v1 = s; }
    for (let k = 0; k < L; k++) {
      const b = k * n2, u = (k + 1) * n2;
      pushTet(b + v0, b + v1, b + v2, u + v0);
      pushTet(b + v1, b + v2, u + v0, u + v1);
      pushTet(b + v2, u + v0, u + v1, u + v2);
    }
  }
  let volume = 0;
  for (let t = 0; t < m; t++) volume += tetDet(particles, tets[4 * t], tets[4 * t + 1], tets[4 * t + 2], tets[4 * t + 3]) / 6;
  // unique edges
  const keys = new Float64Array(6 * m);
  const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  let kc = 0;
  for (let t = 0; t < m; t++) {
    for (const [a, b] of pairs) {
      const i = tets[4 * t + a], j = tets[4 * t + b];
      keys[kc++] = i < j ? i * n + j : j * n + i;
    }
  }
  keys.sort();
  let ne = 0;
  for (let i = 0; i < keys.length; i++) if (i === 0 || keys[i] !== keys[i - 1]) ne++;
  const edges = new Uint32Array(2 * ne);
  for (let i = 0, e = 0; i < keys.length; i++) {
    if (i > 0 && keys[i] === keys[i - 1]) continue;
    edges[2 * e] = Math.floor(keys[i] / n);
    edges[2 * e + 1] = keys[i] - edges[2 * e] * n;
    e++;
  }

  // ---- render surface ----------------------------------------------------------------------
  const rin = inradius(ol);
  const rb = Math.max(0.02, Math.min(FACE.bevel, 0.35 * rin));
  const ss = FACE.surfSpacing;
  const ring = resamplePolygon(ol, ss);
  const N = ring.length >> 1;
  const nrm = new Float64Array(2 * N);
  for (let i = 0; i < N; i++) {
    const h = (i + N - 1) % N, j = (i + 1) % N;
    let ax = ring[2 * i] - ring[2 * h], ay = ring[2 * i + 1] - ring[2 * h + 1];
    let bx = ring[2 * j] - ring[2 * i], by = ring[2 * j + 1] - ring[2 * i + 1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    // outward normal of a CCW edge (dx, dy) is (dy, -dx)
    let nx = ay / la + by / lb, ny = -ax / la - bx / lb;
    const ln = Math.hypot(nx, ny) || 1;
    nrm[2 * i] = nx / ln; nrm[2 * i + 1] = ny / ln;
  }
  // per-vertex bevel radius: the global bevel, limited near tight fillets (local curvature) AND by the largest
  // disc that touches the outline at the vertex (half-plane test against every non-neighbouring edge; exact
  // for the convex outlines used here). The local limit alone let the insets from the two sides of an acute
  // cut wedge cross each other, so the cap ring self-intersected and the piece failed to mesh.
  const rbv = new Float64Array(N);
  {
    const rho = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const h = (i + N - 1) % N, j = (i + 1) % N;
      const ax = ring[2 * i] - ring[2 * h], ay = ring[2 * i + 1] - ring[2 * h + 1];
      const bx = ring[2 * j] - ring[2 * i], by = ring[2 * j + 1] - ring[2 * i + 1];
      const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      rho[i] = (0.5 * (Math.hypot(ax, ay) + Math.hypot(bx, by))) / Math.max(turn, 1e-9);
    }
    const enx = new Float64Array(N), eny = new Float64Array(N), ec = new Float64Array(N);
    for (let e = 0; e < N; e++) {
      const f = (e + 1) % N;
      const ex = ring[2 * f] - ring[2 * e], ey = ring[2 * f + 1] - ring[2 * e + 1];
      const l = Math.hypot(ex, ey) || 1;
      enx[e] = ey / l; eny[e] = -ex / l;
      ec[e] = enx[e] * ring[2 * e] + eny[e] * ring[2 * e + 1];
    }
    for (let i = 0; i < N; i++) {
      const px = ring[2 * i], py = ring[2 * i + 1], nx = nrm[2 * i], ny = nrm[2 * i + 1];
      let ball = Infinity;
      for (let e = 0; e < N; e++) {
        const d0 = Math.min((e - i + N) % N, (i - e + N) % N), d1 = Math.min((e + 1 - i + N) % N, (i - e - 1 + 2 * N) % N);
        if (d0 <= 2 || d1 <= 2) continue; // neighbours: covered by the curvature limit
        const den = 1 - (enx[e] * nx + eny[e] * ny);
        if (den < 1e-9) continue;
        const num = ec[e] - (enx[e] * px + eny[e] * py);
        if (num < 0) continue;
        const t = num / den;
        if (t < ball) ball = t;
      }
      const r3 = Math.min(rho[(i + N - 1) % N], rho[i], rho[(i + 1) % N]);
      rbv[i] = Math.max(0.02, Math.min(rb, 0.8 * r3, 0.7 * ball));
    }
    const slope = 0.3 * ss;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < 2 * N; i++) { const a = i % N, b = (i + 1) % N; rbv[b] = Math.min(rbv[b], rbv[a] + slope); }
      for (let i = 2 * N; i > 0; i--) { const a = i % N, b = (i - 1) % N; rbv[b] = Math.min(rbv[b], rbv[a] + slope); }
    }
  }
  // rim profile rings: each maps a vertex's bevel radius to [inset, zProfile]
  const STEPS = 4;
  const profile = [];
  for (let s = 0; s <= STEPS; s++) {
    const th = -Math.PI / 2 + (Math.PI / 2) * (s / STEPS), c = Math.cos(th), sn = Math.sin(th);
    profile.push(s === 0 ? (r) => [r, -T / 2] : (r) => [r - r * c, -T / 2 + r + r * sn]);
  }
  const S = Math.max(1, Math.round((T - 2 * rb) / (ss * 1.2)));
  for (let s = 1; s < S; s++) profile.push((r) => [0, -T / 2 + r + ((T - 2 * r) * s) / S]);
  for (let s = 0; s <= STEPS; s++) {
    const th = (Math.PI / 2) * (s / STEPS), c = Math.cos(th), sn = Math.sin(th);
    profile.push(s === STEPS ? (r) => [r, T / 2] : (r) => [r - r * c, T / 2 - r + r * sn]);
  }
  const NR = profile.length;

  // cap: inset ring (same xy for back and front) + interior lattice. Safety net: if the inset ring still cannot
  // be meshed, shrink the bevel and retry (a thinner rim beats a failed cut).
  const capRing = new Float64Array(2 * N);
  let capPts = null, capTris = null;
  for (let attempt = 0; ; attempt++) {
    for (let i = 0; i < N; i++) {
      capRing[2 * i] = ring[2 * i] - rbv[i] * nrm[2 * i];
      capRing[2 * i + 1] = ring[2 * i + 1] - rbv[i] * nrm[2 * i + 1];
    }
    try {
      ({ pts: capPts, tris: capTris } = meshPolygon(capRing, ss, 'cap ring'));
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      for (let i = 0; i < N; i++) rbv[i] = Math.max(0.02, rbv[i] * 0.55);
    }
  }
  const nci = (capPts.length >> 1) - N; // interior cap points
  const nv = N * NR + 2 * nci;
  const pos = new Float32Array(3 * nv);
  for (let r = 0; r < NR; r++) {
    for (let i = 0; i < N; i++) {
      const [inset, zp] = profile[r](rbv[i]);
      const x = ring[2 * i] - inset * nrm[2 * i], y = ring[2 * i + 1] - inset * nrm[2 * i + 1];
      const o = 3 * (r * N + i);
      pos[o] = x; pos[o + 1] = y;
      pos[o + 2] = r === 0 ? -T / 2 : zp + (R(x, y) * (zp + T / 2)) / T;
    }
  }
  const backBase = N * NR, frontBase = N * NR + nci;
  for (let q = 0; q < nci; q++) {
    const x = capPts[2 * (N + q)], y = capPts[2 * (N + q) + 1];
    let o = 3 * (backBase + q);
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = -T / 2;
    o = 3 * (frontBase + q);
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = T / 2 + R(x, y);
  }
  const ntr = 2 * N * (NR - 1) + 2 * (capTris.length / 3);
  const index = new Uint32Array(3 * ntr);
  let ic = 0;
  for (let r = 0; r < NR - 1; r++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = r * N + i, b = r * N + j, c = (r + 1) * N + j, d = (r + 1) * N + i;
      index[ic++] = a; index[ic++] = b; index[ic++] = c;
      index[ic++] = a; index[ic++] = c; index[ic++] = d;
    }
  }
  const mapBack = (v) => (v < N ? v : backBase + v - N);
  const mapFront = (v) => (v < N ? (NR - 1) * N + v : frontBase + v - N);
  for (let t = 0; t < capTris.length; t += 3) {
    const a = capTris[t], b = capTris[t + 1], c = capTris[t + 2];
    index[ic++] = mapFront(a); index[ic++] = mapFront(b); index[ic++] = mapFront(c);
    index[ic++] = mapBack(a); index[ic++] = mapBack(c); index[ic++] = mapBack(b);
  }
  const B = FACE.box;
  const uvs = new Float32Array(2 * nv);
  for (let v = 0; v < nv; v++) {
    uvs[2 * v] = (pos[3 * v] - B.x0) / (B.x1 - B.x0);
    uvs[2 * v + 1] = (pos[3 * v + 1] - B.y0) / (B.y1 - B.y0);
  }
  // Print weight: how much of the face photo shows at each render vertex. 1 on the front cap, easing to 0 across
  // the front bevel, 0 on the straight walls (the original rim and every cut face), the back bevel and the back
  // cap. The renderer blends the photo into plain gel by this weight, so a cut through a feature does not smear
  // it down the new wall. One value per vertex of the welded mesh, so the fade has no seams.
  const print = new Float32Array(nv);
  const frontBevel0 = NR - 1 - STEPS; // ring at the top of the straight wall (front bevel, step 0)
  for (let r = frontBevel0 + 1; r < NR; r++) {
    const s = (r - frontBevel0) / STEPS;
    print.fill(s * s * (3 - 2 * s), r * N, (r + 1) * N);
  }
  print.fill(1, frontBase, frontBase + nci);

  const tetMesh = { particles, tets };
  const semb = embedPoints(tetMesh, pos);

  // ---- bubbles -------------------------------------------------------------------------------
  const kept = [];
  for (const bb of bubbles || []) {
    if (!pointInPolygon(ol, bb.x, bb.y)) continue;
    if (distanceToPolygon(ol, bb.x, bb.y) < bb.r + 0.25) continue;
    kept.push(bb);
  }
  const brest = new Float32Array(3 * kept.length), br = new Float32Array(kept.length);
  kept.forEach((bb, i) => { brest[3 * i] = bb.x; brest[3 * i + 1] = bb.y; brest[3 * i + 2] = bb.z; br[i] = bb.r; });
  const bemb = embedPoints(tetMesh, brest);

  return {
    outline: ol,
    area,
    volume,
    particles,
    tets,
    edges,
    surface: { positions: pos, uvs, index, tetOf: semb.tetOf, bary: semb.bary, print },
    bubbles: { rest: brest, r: br, tetOf: bemb.tetOf, bary: bemb.bary },
    // extras (not in the spec contract, used by physics.js)
    cols: n2,          // 2D points per layer; particle id = layer * cols + col
    layers: L,
    boundaryCols: nb,  // cols [0, boundaryCols) lie on the outline (side walls)
    bevel: rb,
  };
}
