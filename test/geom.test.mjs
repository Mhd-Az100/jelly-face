// node test/geom.test.mjs  -- geometry checks for src/geom.js (exit code 1 on failure)
import { createRequire } from 'node:module';
globalThis.Delaunator = (await import('delaunator')).default;
globalThis.ClipperLib = createRequire(import.meta.url)('clipper-lib');

const G = await import('../src/geom.js');
const { validatePiece } = await import('./validate.mjs');

let failures = 0;
function check(name, ok, measured = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${measured !== '' ? '  -- ' + measured : ''}`);
  if (!ok) failures++;
}
const f3 = (v) => (typeof v === 'number' ? +v.toFixed(3) : v);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// geo.surface.print (photo weight per render vertex): 1 on the front cap, a smooth fade across the front bevel,
// 0 on the straight walls (original rim and cut faces), back bevel and back cap. Returns a list of problems.
function printProblems(geo) {
  const S = geo.surface, P = S.positions, W = S.print, T = G.FACE.T;
  const nv = P.length / 3;
  if (!(W instanceof Float32Array) || W.length !== nv) return ['print missing or wrong length'];
  const out = [];
  let range = 0, back = 0, wall = 0, cap = 0, jump = 0, capN = 0, wallN = 0;
  for (let i = 0; i < nv; i++) {
    const w = W[i], x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    if (!(w >= 0 && w <= 1)) range++;
    if (z < -T / 2 + 1e-6 && w !== 0) back++;
    const d = G.distanceToPolygon(geo.outline, x, y);
    // straight walls sit on the outline itself, between the two bevels
    if (d < 1e-3 && z > -T / 2 + geo.bevel + 1e-3) { wallN++; if (w !== 0) wall++; }
    if (d > geo.bevel + 0.02 && z > 0 && G.pointInPolygon(geo.outline, x, y)) { capN++; if (w !== 1) cap++; }
  }
  const I = S.index;
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) jump = Math.max(jump, Math.abs(W[I[t + k]] - W[I[t + (k + 1) % 3]]));
  }
  if (range) out.push(`${range} weights outside [0,1]`);
  if (back) out.push(`${back} back-cap verts printed`);
  if (!wallN || wall) out.push(`${wall}/${wallN} wall verts printed`);
  if (!capN || cap) out.push(`${cap}/${capN} front-cap verts not fully printed`);
  if (jump > 0.4) out.push(`max jump across a triangle edge ${f3(jump)}`);
  return out;
}

// ---------------------------------------------------------------- faceOutline
{
  const ol = G.faceOutline();
  const n = ol.length / 2;
  let minCross = Infinity, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, yAtWidest = 0, wmax = 0;
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n, j = (i + 1) % n;
    const cr = (ol[2 * i] - ol[2 * h]) * (ol[2 * j + 1] - ol[2 * i + 1]) - (ol[2 * i + 1] - ol[2 * h + 1]) * (ol[2 * j] - ol[2 * i]);
    minCross = Math.min(minCross, cr);
    x0 = Math.min(x0, ol[2 * i]); x1 = Math.max(x1, ol[2 * i]);
    y0 = Math.min(y0, ol[2 * i + 1]); y1 = Math.max(y1, ol[2 * i + 1]);
    if (Math.abs(ol[2 * i]) > wmax) { wmax = Math.abs(ol[2 * i]); yAtWidest = ol[2 * i + 1]; }
  }
  const widthAt = (y) => {
    // horizontal chord length of the polygon at height y
    const xs = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ya = ol[2 * i + 1], yb = ol[2 * j + 1];
      if ((ya - y) * (yb - y) <= 0 && ya !== yb) xs.push(ol[2 * i] + ((y - ya) / (yb - ya)) * (ol[2 * j] - ol[2 * i]));
    }
    return Math.max(...xs) - Math.min(...xs);
  };
  check('faceOutline: n=180, Float64Array', ol instanceof Float64Array && n === 180, `n ${n}`);
  check('faceOutline: CCW', G.polygonArea(ol) > 0, `area ${f3(G.polygonArea(ol))} cm^2`);
  check('faceOutline: strictly convex (every turn > 0)', minCross > 0, `min cross ${minCross.toExponential(2)}`);
  check('faceOutline: y in [-6, 6]', near(y0, -6, 1e-6) && near(y1, 6, 1e-6), `y ${f3(y0)}..${f3(y1)}`);
  check('faceOutline: widest ~9.6 cm', near(x1 - x0, 9.6, 0.02), `width ${f3(x1 - x0)}`);
  check('faceOutline: widest point a bit above centre', yAtWidest > 0.2 && yAtWidest < 2, `y at widest ${f3(yAtWidest)}`);
  check('faceOutline: chin narrower than forehead', widthAt(-5) < widthAt(5) - 0.3, `width y=-5 ${f3(widthAt(-5))}, y=+5 ${f3(widthAt(5))}`);
  const o2 = G.faceOutline(64);
  check('faceOutline(64) also convex CCW', o2.length === 128 && G.polygonArea(o2) > 0);
}

// ---------------------------------------------------------------- relief
{
  const L = G.FACE.landmarks;
  const R = G.makeRelief();
  const tip = R(L.noseTip[0], L.noseTip[1]);
  const eye = R(L.eyeL[0], L.eyeL[1]), brow = R(L.eyeL[0], L.browY), cheek = R(L.cheekL[0], L.cheekL[1]);
  const bridge = R(L.noseBridge[0], L.noseBridge[1]), mouth = R(L.mouth[0], L.mouth[1]), lipU = R(L.mouth[0], L.mouth[1] + 0.24);
  check('relief: nose tip ~1.1 cm', tip > 1.0 && tip < 1.25, `tip ${f3(tip)}`);
  check('relief: nose tip is the peak', (() => { let mx = -1; for (let y = -6; y <= 6; y += 0.1) for (let x = -5; x <= 5; x += 0.1) mx = Math.max(mx, R(x, y)); return mx <= tip + 0.02; })());
  check('relief: eye sockets dip below brow and cheek', eye < brow - 0.25 && eye < cheek - 0.25, `eye ${f3(eye)} brow ${f3(brow)} cheek ${f3(cheek)}`);
  check('relief: symmetric', near(R(-2, 0.6), R(2, 0.6), 1e-9) && near(R(-1.3, -3), R(1.3, -3), 1e-9));
  check('relief: slight groove between lips', mouth < lipU - 0.03, `mouth line ${f3(mouth)} upper lip ${f3(lipU)}`);
  check('relief: bridge lower than tip', bridge < tip - 0.3, `bridge ${f3(bridge)}`);
  const ol = G.faceOutline(360);
  let maxOn = 0;
  for (let i = 0; i < ol.length; i += 2) maxOn = Math.max(maxOn, Math.abs(R(ol[i], ol[i + 1])), Math.abs(R(ol[i] * 1.05, ol[i + 1] * 1.05)));
  check('relief: exactly 0 on and outside the original outline', maxOn === 0, `max |R| ${maxOn}`);
  const R0 = G.makeRelief({ depth: 0, emboss: 0 });
  let max0 = 0;
  for (let y = -6; y <= 6; y += 0.25) for (let x = -5; x <= 5; x += 0.25) max0 = Math.max(max0, Math.abs(R0(x, y)));
  check('relief: depth 0 is flat', max0 === 0);
  const Rd = G.makeRelief({ depth: 1.6, emboss: 0 });
  check('relief: depth scales the sculpt', near(Rd(0, -1.5), 1.6 * tip, 1e-9), `depth 1.6 tip ${f3(Rd(0, -1.5))}`);
  // synthetic luminance: a bright left half and a dark right half (row 0 = top)
  const w = 100, h = 125, data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = i < w / 2 ? 1 : 0;
  const Re = G.makeRelief({ depth: 1, emboss: 1, lum: { w, h, data } });
  const dl = Re(-1.5, 3) - R(-1.5, 3), dr = Re(1.5, 3) - R(1.5, 3);
  check('relief: photo emboss raises bright, lowers dark (~ +/-0.175 cm)', dl > 0.1 && dr < -0.1, `bright ${f3(dl)} dark ${f3(dr)}`);
  // vertical flip check: bright top rows only
  const d2 = new Float32Array(w * h);
  for (let j = 0; j < h / 2; j++) for (let i = 0; i < w; i++) d2[j * w + i] = 1;
  const Rt = G.makeRelief({ depth: 0, emboss: 1, lum: { w, h, data: d2 } });
  check('relief: lum row 0 is the forehead (y1)', Rt(0, 3) > 0 && Rt(0, -3) < 0, `forehead ${f3(Rt(0, 3))} chin ${f3(Rt(0, -3))}`);
  // clamp range with extreme settings
  const noise = new Float32Array(w * h);
  for (let k = 0; k < noise.length; k++) noise[k] = (k * 7919) % 13 < 6 ? 0 : 1;
  const Rx = G.makeRelief({ depth: 1.6, emboss: 1, lum: { w, h, data: noise } });
  let lo = Infinity, hi = -Infinity;
  for (let y = -6; y <= 6; y += 0.05) for (let x = -5; x <= 5; x += 0.05) { const v = Rx(x, y); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  check('relief: clamped to [-0.45, 1.8]', lo >= -0.45 && hi <= 1.8, `range ${f3(lo)}..${f3(hi)}`);
}

// ---------------------------------------------------------------- polygon helpers
{
  const sq = Float64Array.from([0, 0, 2, 0, 2, 2, 0, 2]);
  const cw = Float64Array.from([0, 0, 0, 2, 2, 2, 2, 0]);
  check('polygonArea: signed (CCW +, CW -)', G.polygonArea(sq) === 4 && G.polygonArea(cw) === -4);
  check('pointInPolygon', G.pointInPolygon(sq, 1, 1) && !G.pointInPolygon(sq, 3, 1) && !G.pointInPolygon(sq, -0.1, 1));
  check('distanceToPolygon', near(G.distanceToPolygon(sq, 1, 0.5), 0.5, 1e-12) && near(G.distanceToPolygon(sq, 3, 1), 1, 1e-12));
  const rs = G.resamplePolygon(G.faceOutline(), 0.26);
  let maxSeg = 0, minSeg = Infinity;
  for (let i = 0; i < rs.length / 2; i++) {
    const j = (i + 1) % (rs.length / 2);
    const l = Math.hypot(rs[2 * j] - rs[2 * i], rs[2 * j + 1] - rs[2 * i + 1]);
    maxSeg = Math.max(maxSeg, l); minSeg = Math.min(minSeg, l);
  }
  check('resamplePolygon: spacing <= 0.26 and uniform', maxSeg <= 0.2601 && minSeg > 0.2, `seg ${f3(minSeg)}..${f3(maxSeg)}, ${rs.length / 2} pts`);
  const [a, b] = G.splitConvex(sq, { px: 0.5, py: 0, nx: 1, ny: 0 });
  check('splitConvex: exact halves', near(G.polygonArea(a), 1, 1e-12) && near(G.polygonArea(b), 3, 1e-12), `${G.polygonArea(a)} + ${G.polygonArea(b)}`);
  const [c, d] = G.splitConvex(sq, { px: 5, py: 0, nx: 1, ny: 0 });
  check('splitConvex: miss gives one empty side', c.length === 8 && d.length === 0);
  const face = G.faceOutline();
  const [e1, e2] = G.splitConvex(face, { px: 0.3, py: -1, nx: Math.cos(1), ny: Math.sin(1) });
  check('splitConvex: face halves sum to the face', near(G.polygonArea(e1) + G.polygonArea(e2), G.polygonArea(face), 1e-9) && G.polygonArea(e1) > 0 && G.polygonArea(e2) > 0);
  const big = Float64Array.from([0, 0, 4, 0, 4, 4, 0, 4]);
  const rr = G.roundPolygon(big, 1);
  const expect = 16 - (4 - Math.PI);
  let convex = true;
  const m = rr.length / 2;
  for (let i = 0; i < m; i++) {
    const h = (i + m - 1) % m, j = (i + 1) % m;
    const cr = (rr[2 * i] - rr[2 * h]) * (rr[2 * j + 1] - rr[2 * i + 1]) - (rr[2 * i + 1] - rr[2 * h + 1]) * (rr[2 * j] - rr[2 * i]);
    if (cr < -1e-6) convex = false;
  }
  check('roundPolygon: 4x4 square, r=1 -> area 16-(4-pi), CCW, convex', near(G.polygonArea(rr), expect, 0.02) && convex, `area ${f3(G.polygonArea(rr))} (expect ${f3(expect)}), ${m} pts`);
  check('roundPolygon: CW input comes back CCW', G.polygonArea(G.roundPolygon(Float64Array.from([0, 0, 0, 4, 4, 4, 4, 0]), 1)) > 0);
  check('roundPolygon: too thin -> empty', G.roundPolygon(Float64Array.from([0, 0, 4, 0, 4, 0.5, 0, 0.5]), 0.8).length === 0);
  check('roundPolygon: leaves the smooth face outline alone', near(G.polygonArea(G.roundPolygon(face, 0.8)), G.polygonArea(face), 0.02));
  check('inradius: 4x2 rectangle = 1', near(G.inradius(Float64Array.from([0, 0, 4, 0, 4, 2, 0, 2])), 1, 1e-3));
  check('inradius: 3-4-5 triangle = 1', near(G.inradius(Float64Array.from([0, 0, 3, 0, 0, 4])), 1, 1e-3));
  check('inradius: face = 4.8', near(G.inradius(face), 4.8, 0.01), f3(G.inradius(face)));
  check('inradius: non-convex (Clipper fallback) is sane', (() => { const r = G.inradius(Float64Array.from([0, 0, 4, 0, 4, 4, 2, 1, 0, 4])); return r > 0.8 && r < 1.1; })());
}

// ---------------------------------------------------------------- bubbles
{
  const b1 = G.makeBubbles(), b2 = G.makeBubbles(), b3 = G.makeBubbles(8);
  const T = G.FACE.T, ol = G.faceOutline();
  const ok = b1.every((b) => b.r >= 0.05 && b.r <= 0.16 && G.pointInPolygon(ol, b.x, b.y) && b.z - b.r > -T / 2 && b.z + b.r < T / 2 - 0.45);
  check('makeBubbles: 16, deterministic, r in [0.05, 0.16], inside the face volume', b1.length === 16 && JSON.stringify(b1) === JSON.stringify(b2) && ok);
  check('makeBubbles: seed changes layout', JSON.stringify(b1) !== JSON.stringify(b3));
}

// ---------------------------------------------------------------- full piece
let fullGeo;
{
  const R = G.makeRelief();
  const t0 = performance.now();
  const geo = G.buildPiece(G.faceOutline(), R, { bubbles: G.makeBubbles() });
  const ms = performance.now() - t0;
  let t1 = performance.now();
  for (let i = 0; i < 5; i++) G.buildPiece(G.faceOutline(), R, { bubbles: G.makeBubbles() });
  const avg = (performance.now() - t1) / 5;
  fullGeo = geo;
  const v = validatePiece(geo);
  const n = geo.particles.length / 3, m = geo.tets.length / 4;
  console.log(`      full face: ${n} particles, ${m} tets, ${geo.edges.length / 2} edges, ${geo.surface.positions.length / 3} surface verts, ${geo.surface.index.length / 3} tris, ${geo.bubbles.r.length} bubbles; area ${f3(geo.area)} cm^2, volume ${f3(geo.volume)} cm^3; build ${ms.toFixed(1)} ms first, ${avg.toFixed(1)} ms avg`);
  check('buildPiece(face): all tets positive', v.minTetVol > 0, `min tet volume ${f3(v.minTetVol)} cm^3`);
  check('buildPiece(face): surface closed 2-manifold, consistently oriented, genus 0, no degenerate tris', v.ok, v.problems.join('; ') || `min tri area ${f3(v.minTriArea)}`);
  check('buildPiece(face): surface outward and ~ tet volume (within 3%)', v.surfVol > 0 && Math.abs(1 - v.volRatio) < 0.03, `surface ${f3(v.surfVol)} vs tets ${f3(v.tetVol)} (ratio ${f3(v.volRatio)})`);
  check('buildPiece(face): embedding reproduces rest surface within 1e-3 cm', v.embedErr < 1e-3, `max err ${v.embedErr.toExponential(2)} cm`);
  check('buildPiece(face): typed arrays per contract', geo.particles instanceof Float32Array && geo.tets instanceof Uint32Array && geo.edges instanceof Uint32Array
    && geo.surface.positions instanceof Float32Array && geo.surface.uvs instanceof Float32Array && geo.surface.index instanceof Uint32Array
    && geo.surface.tetOf instanceof Uint32Array && geo.surface.bary instanceof Float32Array && geo.outline instanceof Float64Array
    && geo.bubbles.rest instanceof Float32Array && geo.bubbles.r instanceof Float32Array && geo.bubbles.tetOf instanceof Uint32Array && geo.bubbles.bary instanceof Float32Array);
  // front cap = T/2 + R and back = -T/2
  const P = geo.surface.positions, T = G.FACE.T;
  let zmin = Infinity, zmax = -Infinity, capErr = 0;
  for (let i = 0; i < P.length; i += 3) {
    zmin = Math.min(zmin, P[i + 2]); zmax = Math.max(zmax, P[i + 2]);
    if (P[i + 2] > T / 2 - 1e-6 && Math.hypot(P[i], P[i + 1]) < 3) capErr = Math.max(capErr, Math.abs(P[i + 2] - (T / 2 + R(P[i], P[i + 1]))));
  }
  check('buildPiece(face): back at -T/2, front cap at T/2 + R', near(zmin, -T / 2, 1e-5) && capErr < 1e-5 && near(zmax, T / 2 + R(0, -1.5), 0.05), `z ${f3(zmin)}..${f3(zmax)}`);
  const uv = geo.surface.uvs;
  let uvok = true;
  for (let i = 0; i < uv.length; i++) if (!(uv[i] >= 0 && uv[i] <= 1)) uvok = false;
  const iTop = (() => { let b = 0; for (let i = 0; i < P.length / 3; i++) if (P[3 * i + 1] > P[3 * b + 1]) b = i; return b; })();
  check('buildPiece(face): uvs planar via FACE.box, in [0,1], forehead at v~1', uvok && near(uv[2 * iTop + 1], (P[3 * iTop + 1] + 6.25) / 12.5, 1e-6) && uv[2 * iTop + 1] > 0.9);
  // bubbles
  let bubErr = 0;
  const B = geo.bubbles;
  for (let i = 0; i < B.r.length; i++) {
    const t = 4 * B.tetOf[i];
    let mn = Infinity;
    for (let q = 0; q < 4; q++) mn = Math.min(mn, B.bary[4 * i + q]);
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let q = 0; q < 4; q++) s += B.bary[4 * i + q] * geo.particles[3 * geo.tets[t + q] + c];
      bubErr = Math.max(bubErr, Math.abs(s - B.rest[3 * i + c]));
    }
    if (mn < -1e-5) bubErr = Infinity;
  }
  check('buildPiece(face): bubbles kept and embedded inside tets', B.r.length >= 12 && bubErr < 1e-4, `${B.r.length} bubbles, err ${bubErr.toExponential(2)}`);
  check('buildPiece(face): extras cols/layers/boundaryCols', geo.cols * (geo.layers + 1) === n && geo.boundaryCols > 0 && geo.layers === G.FACE.layers);
  {
    const pp = printProblems(geo);
    let ones = 0;
    for (const w of geo.surface.print) if (w === 1) ones++;
    check('buildPiece(face): surface.print = 1 on the front cap, 0 on walls/back, smooth across the bevel', !pp.length, pp.join('; ') || `${ones}/${geo.surface.print.length} verts fully printed`);
  }
  // determinism (remold relies on identical 2D meshes for the same outline)
  const geo2 = G.buildPiece(geo.outline, G.makeRelief({ depth: 1.6 }), {});
  let same = geo2.cols === geo.cols && geo2.tets.length === geo.tets.length;
  for (let i = 0; same && i < geo.cols; i++) if (geo2.particles[3 * i] !== geo.particles[3 * i] || geo2.particles[3 * i + 1] !== geo.particles[3 * i + 1]) same = false;
  check('buildPiece: same outline -> same 2D mesh (any relief)', same);
  // counts per layer / consistency of the conforming split: every interior tet face shared by exactly 2 tets
  const faces = new Map();
  const FF = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
  for (let t = 0; t < m; t++) for (const f of FF) {
    const k = [geo.tets[4 * t + f[0]], geo.tets[4 * t + f[1]], geo.tets[4 * t + f[2]]].sort((a, b) => a - b).join(',');
    faces.set(k, (faces.get(k) || 0) + 1);
  }
  let over = 0;
  for (const c of faces.values()) if (c > 2) over++;
  let bnd = 0;
  for (const c of faces.values()) if (c === 1) bnd++;
  // boundary faces of a conforming mesh form a closed surface: Euler V - E + F = 2 on the boundary
  check('tet mesh conforming: no face shared by > 2 tets', over === 0, `${faces.size} faces, ${bnd} on the boundary`);
}

// ---------------------------------------------------------------- embedPoints
{
  const geo = fullGeo;
  const n = 400;
  const pts = new Float32Array(3 * n), want = [];
  let s = 12345;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const t = Math.floor(rnd() * geo.tets.length / 4);
    let w = [rnd(), rnd(), rnd(), rnd()];
    const ws = w.reduce((a, b) => a + b, 0);
    w = w.map((v) => v / ws);
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let q = 0; q < 4; q++) v += w[q] * geo.particles[3 * geo.tets[4 * t + q] + c];
      pts[3 * i + c] = v;
    }
  }
  const t0 = performance.now();
  const emb = G.embedPoints({ particles: geo.particles, tets: geo.tets }, pts);
  const ms = performance.now() - t0;
  let err = 0, minB = Infinity;
  for (let i = 0; i < n; i++) {
    const t = 4 * emb.tetOf[i];
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let q = 0; q < 4; q++) v += emb.bary[4 * i + q] * geo.particles[3 * geo.tets[t + q] + c];
      err = Math.max(err, Math.abs(v - pts[3 * i + c]));
    }
    for (let q = 0; q < 4; q++) minB = Math.min(minB, emb.bary[4 * i + q]);
  }
  check('embedPoints: interior points exact, inside their tet', err < 1e-4 && minB > -1e-4, `err ${err.toExponential(2)}, min bary ${minB.toExponential(2)}, ${ms.toFixed(1)} ms for ${n}`);
  const far = Float32Array.from([30, 0, 0, 0, 0, 9, 4.9, 0, 0]);
  const ef = G.embedPoints({ particles: geo.particles, tets: geo.tets }, far);
  let mb = Infinity, sums = [];
  for (let i = 0; i < 3; i++) {
    let su = 0;
    for (let q = 0; q < 4; q++) { mb = Math.min(mb, ef.bary[4 * i + q]); su += ef.bary[4 * i + q]; }
    sums.push(su);
  }
  check('embedPoints: far points clamp sanely (weights >= -0.6, sum 1)', mb >= -0.6 - 1e-5 && sums.every((v) => near(v, 1, 1e-5)), `min bary ${f3(mb)}`);
}

// ---------------------------------------------------------------- slice pieces
{
  const R = G.makeRelief();
  const face = G.faceOutline();
  const cuts = [
    { px: 0, py: 0, nx: 1, ny: 0 }, { px: 0, py: 1, nx: 0, ny: 1 }, { px: 1, py: -2, nx: Math.cos(0.7), ny: Math.sin(0.7) },
    { px: -3, py: 0, nx: 1, ny: 0.2 }, { px: 0, py: 4.2, nx: 0.1, ny: 1 }, { px: 2, py: 2, nx: Math.cos(2.5), ny: Math.sin(2.5) },
  ];
  let valid = 0, total = 0, worst = 1, minTet = Infinity, maxEmb = 0;
  const problems = [], printBad = [];
  // one level of splits, then split each half again with a crossing line; two fillet radii
  for (const rad of [0.8, 0.25]) {
    for (const c of cuts) {
      for (const half of G.splitConvex(face, c)) {
        if (!half.length) continue;
        const sub = G.splitConvex(half, { px: c.px + 0.7, py: c.py - 0.4, nx: -c.ny, ny: c.nx });
        for (const poly of [half, ...sub]) {
          if (!poly.length) continue;
          const r = G.roundPolygon(poly, rad);
          if (r.length < 6 || G.polygonArea(r) < 3 || G.inradius(r) < 0.75) continue;
          total++;
          try {
            const g = G.buildPiece(r, R, { bubbles: G.makeBubbles() });
            const v = validatePiece(g);
            worst = Math.min(worst, 1 - Math.abs(1 - v.volRatio));
            minTet = Math.min(minTet, v.minTetVol);
            maxEmb = Math.max(maxEmb, v.embedErr);
            if (v.ok) valid++; else problems.push(v.problems.join(','));
            const pp = printProblems(g);
            if (pp.length) printBad.push(pp.join(','));
          } catch (e) {
            problems.push(e.message);
          }
        }
      }
    }
  }
  check('slice pieces: positive tets, closed outward surfaces, exact embedding', valid === total && total > 20, `${valid}/${total} valid; min tet ${f3(minTet)} cm^3; max embed err ${maxEmb.toExponential(2)}; surf/tet volume within ${f3(100 * (1 - worst))}% ${problems.slice(0, 3).join(' | ')}`);
  check('slice pieces: surface.print leaves every cut wall unprinted', !printBad.length && total > 20, printBad.slice(0, 3).join(' | ') || `${total} pieces`);
  // a cut straight through the eyes: the new wall (rest points on the cut line) carries no photo, while the
  // front cap right next to it (beyond the bevel) is fully printed
  const eyeY = G.FACE.landmarks.eyeL[1];
  let wallVerts = 0, wallPrinted = 0, capNear = 0, capNearOff = 0;
  for (const half of G.splitConvex(face, { px: 0, py: eyeY, nx: 0, ny: 1 })) {
    const g = G.buildPiece(G.roundPolygon(half, G.FACE.cornerRadius), R);
    const P = g.surface.positions, W = g.surface.print;
    for (let i = 0; i < W.length; i++) {
      const x = P[3 * i], dy = Math.abs(P[3 * i + 1] - eyeY), z = P[3 * i + 2];
      if (Math.abs(x) > 3) continue;
      if (dy < 0.01 && z > -G.FACE.T / 2 + g.bevel) { wallVerts++; if (W[i] !== 0) wallPrinted++; }
      if (dy > g.bevel + 0.05 && dy < g.bevel + 0.6 && z > 0) { capNear++; if (W[i] !== 1) capNearOff++; }
    }
  }
  check('cut through the eyes: wall unprinted, adjacent front cap fully printed', wallVerts > 20 && !wallPrinted && capNear > 20 && !capNearOff,
    `${wallPrinted}/${wallVerts} wall verts printed, ${capNearOff}/${capNear} near-cap verts not printed`);
  check('slice pieces: surface volume within 6% of tet volume', worst > 0.94, f3(worst));
}

// ---------------------------------------------------------------- acute wedges (regression)
// Two cuts through one apex leave a narrow wedge with a small fillet. The per-vertex bevel used to be limited by
// local curvature only, so the cap rings of such wedges self-intersected and buildPiece threw (slice() then
// reported 'Too thin to slice.' for a perfectly good cut; 4 of these 20 failed).
{
  const R = G.makeRelief(), face = G.faceOutline();
  let total = 0, valid = 0, minBevel = Infinity;
  const problems = [];
  for (const [ax, ay, dir] of [[0, -4.5, 0.2], [-2.5, 3, -1.9], [3, 0, 2.9], [0.5, 5, -1.4]]) {
    for (const half of [0.2, 0.3, 0.42]) {
      for (const rad of [0.2, 0.3]) {
        const a1 = dir + half, a2 = dir - half;
        const [, p1] = G.splitConvex(face, { px: ax, py: ay, nx: Math.sin(a1), ny: -Math.cos(a1) });
        if (!p1.length) continue;
        const [p2] = G.splitConvex(p1, { px: ax, py: ay, nx: Math.sin(a2), ny: -Math.cos(a2) });
        if (!p2.length) continue;
        const r = G.roundPolygon(p2, rad);
        if (r.length < 6 || G.polygonArea(r) < 3 || G.inradius(r) < 0.75) continue;
        total++;
        try {
          const g = G.buildPiece(r, R);
          const v = validatePiece(g);
          minBevel = Math.min(minBevel, g.bevel);
          if (v.ok) valid++; else problems.push(v.problems.join(','));
        } catch (e) { problems.push(e.message); }
      }
    }
  }
  check('acute wedge pieces mesh (cap ring stays simple)', total >= 16 && valid === total, `${valid}/${total} valid ${problems.slice(0, 2).join(' | ')}`);
}

// ---------------------------------------------------------------- nested cuts stay convex (regression)
// Split, round, split the result again ... (what repeated slicing does to one piece). roundPolygon used to run
// every piece through ClipperOffset; its integer grid left back-steps that the round offset turned into V
// notches (~1 cut in 9), and later cuts inherited them. Every generation must stay convex.
{
  const face = G.faceOutline();
  let s = 4242;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let worst = 0, gens = 0;
  for (let run = 0; run < 12; run++) {
    let poly = face;
    for (let gen = 0; gen < 4; gen++) {
      const [cx, cy] = [poly.reduce((a, v, i) => (i % 2 ? a : a + v), 0) / (poly.length / 2), poly.reduce((a, v, i) => (i % 2 ? a + v : a), 0) / (poly.length / 2)];
      const a = rnd() * Math.PI * 2, off = (rnd() - 0.5) * 1.5;
      const halves = G.splitConvex(poly, { px: cx + off * Math.cos(a), py: cy + off * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) }).filter((h) => h.length);
      if (!halves.length) break;
      const big = halves.reduce((p, q) => (Math.abs(G.polygonArea(q)) > Math.abs(G.polygonArea(p)) ? q : p));
      const r = G.roundPolygon(big, 0.2 + 0.6 * rnd());
      if (r.length < 6 || G.polygonArea(r) < 3) break;
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const h = (i + n - 1) % n, j = (i + 1) % n;
        const ax = r[2 * i] - r[2 * h], ay = r[2 * i + 1] - r[2 * h + 1], bx = r[2 * j] - r[2 * i], by = r[2 * j + 1] - r[2 * i + 1];
        worst = Math.min(worst, (ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by)));
      }
      poly = r;
      gens++;
    }
  }
  check('roundPolygon: nested cut generations stay convex (no notches)', gens >= 36 && worst > -1e-6, `${gens} generations, worst turn sin ${worst.toExponential(2)}`);
  // a half captured from a random slice sequence (a second-generation wedge, 4-decimal coordinates) for which
  // the Clipper-only rounding returned a V notch (worst turn sin -0.998)
  const captured = Float64Array.from([1.367, 1.32, 1.2737, 1.3553, 1.1805, 1.3907, 1.087, 1.4256, 0.9939, 1.4612, 0.9012, 1.4961, 0.8082, 1.5323, 0.7148, 1.5673, 0.6227, 1.602, 0.5296, 1.6378, 0.4362, 1.6728, 0.3441, 1.7074, 0.2509, 1.7429, 0.158, 1.7789, 0.0646, 1.8139, -0.0285, 1.8496, -0.1218, 1.8848, -0.2152, 1.9198, -0.3083, 1.9554, -0.402, 1.9897, -0.4941, 2.0264, -0.5877, 2.0609, -0.681, 2.0962, -0.7739, 2.1324, -0.8673, 2.1675, -0.9594, 2.2021, -1.0526, 2.2376, -1.1456, 2.2735, -1.2389, 2.3087, -1.3323, 2.3437, -1.4254, 2.3794, -1.5191, 2.4136, -1.6112, 2.4503, -1.6564, 2.4673, -1.0329, -2.3276, -1.0103, -2.303, -0.9428, -2.2296, -0.8753, -2.1562, -0.8078, -2.0827, -0.7403, -2.0093, -0.6728, -1.9359, -0.6053, -1.8624, -0.5378, -1.789, -0.4703, -1.7155, -0.4028, -1.6421, -0.3353, -1.5687, -0.2678, -1.4952, -0.2002, -1.4218, -0.1327, -1.3484, -0.0652, -1.2749, 0.0023, -1.2015, 0.0698, -1.128, 0.1373, -1.0546, 0.2048, -0.9812, 0.2723, -0.9077, 0.3398, -0.8343, 0.4073, -0.7609, 0.4748, -0.6874, 0.5423, -0.614, 0.6098, -0.5406, 0.6773, -0.4671, 0.7448, -0.3937, 0.8123, -0.3202, 0.8799, -0.2468, 0.9474, -0.1734, 1.0149, -0.0999, 1.0824, -0.0265, 1.1499, 0.0469, 1.2174, 0.1204, 1.2849, 0.1938, 1.3524, 0.2673, 1.4199, 0.3407, 1.4874, 0.4141, 1.5549, 0.4876, 1.6224, 0.561, 1.6863, 0.6374, 1.733, 0.7253, 1.7575, 0.8216, 1.7591, 0.9211, 1.7375, 1.0181, 1.6937, 1.1074, 1.6306, 1.1844, 1.551, 1.244, 1.4602, 1.2847]);
  const rc = G.roundPolygon(captured, 0.2985);
  let wc = 0;
  const nc = rc.length / 2;
  for (let i = 0; i < nc; i++) {
    const h = (i + nc - 1) % nc, j = (i + 1) % nc;
    const ax = rc[2 * i] - rc[2 * h], ay = rc[2 * i + 1] - rc[2 * h + 1], bx = rc[2 * j] - rc[2 * i], by = rc[2 * j + 1] - rc[2 * i + 1];
    wc = Math.min(wc, (ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by)));
  }
  check('roundPolygon: captured notch case comes back convex', nc > 20 && wc > -1e-6 && Math.abs(G.polygonArea(rc) - G.polygonArea(captured)) < 0.3, `worst turn sin ${wc.toExponential(2)}, area ${f3(G.polygonArea(captured))} -> ${f3(G.polygonArea(rc))}`);
}

// ---------------------------------------------------------------- inradius of grid-snapped outlines (regression)
// Outlines that went through Clipper's 0.001 cm grid are only nearly convex; they must still take the exact
// half-plane path (the ClipperOffset bisection fallback made inradius ~90 % of the cost of slice()).
// Timing is wall clock, so one scheduler stall or GC pause inside a timed call (CPU shared with headless Chrome)
// used to blow up a plain mean (a run once reported 19 ms "per call" while the calls take ~0.3 ms). Each polygon is
// timed 3 times and keeps its fastest run, and the check uses the median over polygons: robust to stalls, while a
// fall back to the Clipper path (~30x slower on every call) still fails it. The path itself is checked without a
// clock: ClipperLib is wrapped so every ClipperOffset the snapped calls construct is counted (must be 0).
{
  const face = G.faceOutline();
  let maxd = 0;
  const best = [];
  const realCL = globalThis.ClipperLib;
  let offsets = 0, snappedOffsets = 0;
  globalThis.ClipperLib = new Proxy(realCL, { get(t, k) { if (k === 'ClipperOffset') offsets++; return t[k]; } });
  for (let k = 0; k < 24; k++) {
    const a = k * 0.37, halves = G.splitConvex(face, { px: Math.cos(k * 1.3) * 3, py: Math.sin(k * 0.7) * 4, nx: Math.cos(a), ny: Math.sin(a) });
    for (const h of halves) {
      if (!h.length) continue;
      const r = G.roundPolygon(h, 0.5);
      if (!r.length) continue;
      const snapped = r.map((v) => Math.round(v * 1000) / 1000);
      let ir = 0, fastest = Infinity;
      const o0 = offsets;
      for (let rep = 0; rep < 3; rep++) {
        const t0 = performance.now();
        ir = G.inradius(snapped);
        fastest = Math.min(fastest, performance.now() - t0);
      }
      snappedOffsets += offsets - o0;
      best.push(fastest);
      const ih = G.inradius(h);
      if (ih > 0.6) maxd = Math.max(maxd, Math.abs(ir - ih));
    }
  }
  // the counter itself works: the non-convex case must go through ClipperOffset
  const o1 = offsets;
  G.inradius(Float64Array.from([0, 0, 4, 0, 4, 4, 2, 1, 0, 4]));
  const fallbackSeen = offsets > o1;
  globalThis.ClipperLib = realCL;
  best.sort((p, q) => p - q);
  const med = best.length ? best[best.length >> 1] : Infinity;
  check('inradius: grid-snapped rounded pieces match their exact halves, fast path', maxd < 2e-3 && best.length > 20 && snappedOffsets === 0 && fallbackSeen && med < 3,
    `max diff ${maxd.toExponential(2)} cm, ${snappedOffsets} ClipperOffset fallbacks; median ${f3(med)} ms per call (best of 3) over ${best.length}, slowest ${f3(best[best.length - 1])} ms`);
}

console.log(failures ? `\n${failures} geometry check(s) FAILED` : '\nall geometry checks passed');
process.exit(failures ? 1 : 0);
