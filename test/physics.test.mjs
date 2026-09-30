// node test/physics.test.mjs  -- tuning targets 1-7 of SPEC section 5 plus invariants (exit code 1 on failure)
import { createRequire } from 'node:module';
globalThis.Delaunator = (await import('delaunator')).default;
globalThis.ClipperLib = createRequire(import.meta.url)('clipper-lib');

const G = await import('../src/geom.js');
const { World, Body, TUNING } = await import('../src/physics.js');
const { validatePiece } = await import('./validate.mjs');

let failures = 0;
function check(name, ok, measured = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${measured !== '' ? '  -- ' + measured : ''}`);
  if (!ok) failures++;
}
const f3 = (v) => +(+v).toFixed(3);
const relief = G.makeRelief();

// ---------------------------------------------------------------- helpers
function newWorld(params = {}, lift = 5) {
  const w = new World();
  Object.assign(w.params, params);
  w.pour(relief, { lift });
  return w;
}
function yRange(b) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < b.x.length; i += 3) { lo = Math.min(lo, b.x[i]); hi = Math.max(hi, b.x[i]); }
  return [lo, hi];
}
function restHeight(b) {
  const P = b.geo.particles;
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < P.length; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); }
  return hi - lo;
}
function finite(w) {
  for (const b of w.bodies) {
    for (let i = 0; i < b.x.length; i++) if (!Number.isFinite(b.x[i]) || !Number.isFinite(b.v[i])) return false;
  }
  return true;
}
// floor / wall invariant for the current state
function inBounds(w) {
  for (const b of w.bodies) {
    for (let i = 0; i < b.n; i++) {
      if (b.x[3 * i + 1] < 0 || Math.abs(b.x[3 * i]) > 28 || Math.abs(b.x[3 * i + 2]) > 28) return false;
    }
  }
  return true;
}
// column (2D mesh point) nearest to rest (x, y); returns [bottom particle, top particle]
function column(b, x, y) {
  const g = b.geo;
  let best = 0, bd = Infinity;
  for (let i = 0; i < g.cols; i++) {
    const d = Math.hypot(g.particles[3 * i] - x, g.particles[3 * i + 1] - y);
    if (d < bd) { bd = d; best = i; }
  }
  return [best, g.layers * g.cols + best];
}
// Number of particles of body a that lie inside some tet of body b (world positions).
function particlesInside(a, b) {
  const T = b.geo.tets, x = b.x;
  const vol = (p, q, r, s) => {
    const e1x = q[0] - p[0], e1y = q[1] - p[1], e1z = q[2] - p[2];
    const e2x = r[0] - p[0], e2y = r[1] - p[1], e2z = r[2] - p[2];
    const e3x = s[0] - p[0], e3y = s[1] - p[1], e3z = s[2] - p[2];
    return (e1y * e2z - e1z * e2y) * e3x + (e1z * e2x - e1x * e2z) * e3y + (e1x * e2y - e1y * e2x) * e3z;
  };
  let cnt = 0;
  for (let i = 0; i < a.n; i++) {
    const q = [a.x[3 * i], a.x[3 * i + 1], a.x[3 * i + 2]];
    for (let t = 0; t < T.length / 4; t++) {
      const P = [0, 1, 2, 3].map((k) => { const id = 3 * T[4 * t + k]; return [x[id], x[id + 1], x[id + 2]]; });
      if (vol(q, P[1], P[2], P[3]) >= 0 && vol(P[0], q, P[2], P[3]) >= 0 && vol(P[0], P[1], q, P[3]) >= 0 && vol(P[0], P[1], P[2], q) >= 0) { cnt++; break; }
    }
  }
  return cnt;
}
function maxStretch(b) {
  const E = b.geo.edges, x = b.x;
  let m = 0;
  for (let e = 0; e < E.length / 2; e++) {
    const i = 3 * E[2 * e], j = 3 * E[2 * e + 1];
    m = Math.max(m, Math.hypot(x[j] - x[i], x[j + 1] - x[i + 1], x[j + 2] - x[i + 2]) / b.restLen[e]);
  }
  return m;
}
function dominantFreq(sig, dt, fmin = 1, fmax = 20) {
  const mean = sig.reduce((a, c) => a + c, 0) / sig.length;
  let bf = 0, bp = -1;
  for (let f = fmin; f <= fmax + 1e-9; f += 0.1) {
    let re = 0, im = 0;
    for (let i = 0; i < sig.length; i++) { const a = 2 * Math.PI * f * i * dt; re += (sig[i] - mean) * Math.cos(a); im += (sig[i] - mean) * Math.sin(a); }
    if (re * re + im * im > bp) { bp = re * re + im * im; bf = f; }
  }
  return bf;
}
// run until the body leaves the mat and comes back (landing after a nudge); returns landing time
function stepUntilLanded(w, b, dt, maxT = 1) {
  let air = false;
  for (let t = 0; t < maxT; t += dt) {
    w.step(dt);
    const lo = yRange(b)[0];
    if (lo > 0.02) air = true;
    if (air && lo <= 1e-6) return w.time;
  }
  return w.time;
}
// deformation of the top-centre relative to the bottom of the same column, sampled every dt
function recordTopCentre(w, b, dt, T) {
  const [bot, top] = column(b, 0, 0);
  const s = [];
  for (let t = 0; t < T; t += dt) {
    w.step(dt);
    s.push([b.x[3 * top] - b.x[3 * bot], b.x[3 * top + 1] - b.x[3 * bot + 1], b.x[3 * top + 2] - b.x[3 * bot + 2]]);
  }
  return s;
}
function amplitude(s, eq, i0, i1) {
  let m = 0;
  for (let i = Math.max(0, i0); i < Math.min(s.length, i1); i++) m = Math.max(m, Math.hypot(s[i][0] - eq[0], s[i][1] - eq[1], s[i][2] - eq[2]));
  return m;
}
function meanVec(s, i0, i1) {
  const e = [0, 0, 0];
  for (let i = i0; i < i1; i++) for (let c = 0; c < 3; c++) e[c] += s[i][c] / (i1 - i0);
  return e;
}

console.log(`TUNING ${JSON.stringify(TUNING)}`);

// ---------------------------------------------------------------- 1. pour and settle (default params)
{
  const w = newWorld({}, 5);
  const b = w.bodies[0];
  const m0 = w.metrics();
  let land = null, settle = null, fin = true, bounds = true, vmin = Infinity, vmax = -Infinity;
  const dt = 1 / 120;
  for (let t = 0; t < 3 - 1e-9; t += dt) {
    w.step(dt);
    if (land === null && yRange(b)[0] <= 1e-6) land = w.time;
    const m = w.metrics();
    if (m.kineticUJ < 1) { if (settle === null) settle = w.time; } else settle = null;
    fin = fin && finite(w);
    bounds = bounds && inBounds(w);
    if (land !== null) { vmin = Math.min(vmin, m.volumePct); vmax = Math.max(vmax, m.volumePct); }
  }
  const m = w.metrics();
  console.log(`      pour: mass ${f3(m0.massG)} g, rest volume ${f3(b.restVolume)} cm^3, ${m0.particles} particles, ${m0.tets} tets`);
  check('1. lands on the mat', land !== null && land > 0.08 && land < 0.13, `first contact at t=${f3(land)} s (free fall 5 cm = 0.101 s)`);
  check('1. kinetic < 1 uJ by t = 3 s (and stays)', settle !== null && m.kineticUJ < 1, `KE(3 s) ${m.kineticUJ.toExponential(2)} uJ, below 1 uJ from t=${f3(settle)} s`);
  check('1. no NaN, never below the floor or outside the walls', fin && bounds);
  check('1. volume 97-103 % of rest at t = 3 s', m.volumePct >= 97 && m.volumePct <= 103, `${f3(m.volumePct)} % (range after landing ${f3(vmin)}..${f3(vmax)} %)`);
  check('1. metrics fields', ['massG', 'volumePct', 'kineticUJ', 'pieces', 'particles', 'tets'].every((k) => Number.isFinite(m[k])) && m.pieces === 1);
}

// ---------------------------------------------------------------- 2. static sag, wobble frequency
{
  const hr = (params, lift, settleT = 3) => {
    const w = newWorld(params, lift);
    const b = w.bodies[0];
    for (let t = 0; t < settleT; t += 1 / 60) w.step(1 / 60);
    return { w, b, r: yRange(b)[1] / restHeight(b) };
  };
  const d = hr({}, 5);
  const s0 = hr({ firmness: 0 }, 5);
  const s1 = hr({ firmness: 1 }, 5);
  // the same body softened after it has come to rest
  const w2 = d.w;
  w2.params.firmness = 0;
  for (let t = 0; t < 2; t += 1 / 60) w2.step(1 / 60);
  const soft = yRange(d.b)[1] / restHeight(d.b);
  check('2. static height >= 88 % of rest at firmness 0.55', d.r >= 0.88, `${f3(100 * d.r)} % (rest height ${f3(restHeight(d.b))} cm, poured from 5 cm)`);
  check('2. static height >= 78 % of rest at firmness 0', s0.r >= 0.78 && soft >= 0.78, `${f3(100 * s0.r)} % poured at firmness 0; ${f3(100 * soft)} % when softened at rest; firmness 1: ${f3(100 * s1.r)} %`);

  // dominant wobble after a nudge (default firmness and damping), and visible wobble at firmness 0
  const wobble = (firmness) => {
    const w = newWorld({ firmness }, 0.3);
    const b = w.bodies[0];
    for (let t = 0; t < 2.5; t += 1 / 60) w.step(1 / 60);
    w.nudge();
    const dt = 1 / 600;
    stepUntilLanded(w, b, dt);
    const s = recordTopCentre(w, b, dt, 1.4);
    const seg = s.slice(60, 780); // 0.1 .. 1.3 s after landing
    const vars = [0, 1, 2].map((c) => { const m = seg.reduce((a, v) => a + v[c], 0) / seg.length; return seg.reduce((a, v) => a + (v[c] - m) ** 2, 0); });
    const cDom = vars.indexOf(Math.max(...vars));
    const freq = dominantFreq(seg.map((v) => v[cDom]), dt);
    let lo = Infinity, hi = -Infinity;
    for (const v of s.slice(0, 600)) { lo = Math.min(lo, v[cDom]); hi = Math.max(hi, v[cDom]); }
    return { freq, p2p: hi - lo, axis: 'xyz'[cDom] };
  };
  const wd = wobble(0.55), w0 = wobble(0), w1 = wobble(1);
  check('2. dominant wobble after a nudge is 3-9 Hz at default firmness', wd.freq >= 3 && wd.freq <= 9, `${f3(wd.freq)} Hz (${wd.axis} sway of the top centre); firmness 0: ${f3(w0.freq)} Hz, firmness 1: ${f3(w1.freq)} Hz`);
  check('2. still wobbles visibly at firmness 0', w0.p2p > 0.3, `top-centre sway ${f3(w0.p2p)} cm peak-to-peak in the first second after landing (default ${f3(wd.p2p)} cm)`);
}

// ---------------------------------------------------------------- 3. damping extremes
{
  // lively: body at rest, damping 0, nudge; oscillation of the top centre (relative to its column bottom)
  const w = newWorld({}, 0.3);
  const b = w.bodies[0];
  for (let t = 0; t < 2.5; t += 1 / 60) w.step(1 / 60);
  w.params.damping = 0;
  w.nudge();
  const dt = 1 / 600;
  stepUntilLanded(w, b, dt);
  const s = recordTopCentre(w, b, dt, 3.2);
  const eq = meanVec(s, 1500, 1920);
  const a1 = amplitude(s, eq, 0, 180), a15 = amplitude(s, eq, 900, 1020);
  // the same measured from the first landing of a 5 cm pour (reported only: the impact squash dominates a1)
  const wp = newWorld({ damping: 0 }, 5);
  const bp = wp.bodies[0];
  while (yRange(bp)[0] > 1e-6) wp.step(dt);
  const sp = recordTopCentre(wp, bp, dt, 3.2);
  const eqp = meanVec(sp, 1500, 1920);
  const pa1 = amplitude(sp, eqp, 0, 180), pa15 = amplitude(sp, eqp, 900, 1020);
  check('3. damping 0: top-centre oscillation after 1.5 s > 5 % of the first amplitude', a15 > 0.05 * a1,
    `after a nudge: first ${f3(a1)} cm, at 1.5-1.7 s ${f3(a15)} cm (${f3(100 * a15 / a1)} %); after the 5 cm pour landing: ${f3(pa1)} -> ${f3(pa15)} cm (${f3(100 * pa15 / pa1)} %)`);

  // syrupy: pour with damping 1, KE < 1 uJ within 0.6 s of landing
  const ws = newWorld({ damping: 1 }, 5);
  const bs = ws.bodies[0];
  let land = null, settle = null;
  for (let t = 0; t < 2; t += 1 / 300) {
    ws.step(1 / 300);
    if (land === null && yRange(bs)[0] <= 1e-6) land = ws.time;
    const ke = ws.metrics().kineticUJ;
    if (ke < 1) { if (settle === null && land !== null) settle = ws.time; } else settle = null;
  }
  check('3. damping 1: settles (KE < 1 uJ) within 0.6 s of landing', settle !== null && settle - land <= 0.6, `settled ${f3(settle - land)} s after landing; KE(2 s) ${ws.metrics().kineticUJ.toExponential(2)} uJ`);
  // with a nudge too
  ws.nudge();
  const l2 = stepUntilLanded(ws, bs, 1 / 300);
  let s2 = null;
  for (let t = 0; t < 1.2; t += 1 / 300) { ws.step(1 / 300); if (ws.metrics().kineticUJ < 1) { if (s2 === null) s2 = ws.time; } else s2 = null; }
  check('3. damping 1: settles within 0.6 s of landing after a nudge', s2 !== null && s2 - l2 <= 0.6, `${f3(s2 - l2)} s`);
}

// ---------------------------------------------------------------- 4. grab
{
  const w = newWorld({}, 0.3);
  const b = w.bodies[0];
  for (let t = 0; t < 2; t += 1 / 60) w.step(1 / 60);
  b.updateSurface();
  // the surface point over the forehead (rest (0, 4), front)
  const S = b.geo.surface.positions;
  let vi = 0, bd = Infinity;
  for (let v = 0; v < S.length / 3; v++) {
    const d = Math.hypot(S[3 * v], S[3 * v + 1] - 4, S[3 * v + 2] - 3);
    if (d < bd) { bd = d; vi = v; }
  }
  const pt = [b.surfacePositions[3 * vi], b.surfacePositions[3 * vi + 1], b.surfacePositions[3 * vi + 2]];
  const ok = w.beginGrab(b, pt);
  const c0 = b.centroid();
  let ms = 0, fin = true, bounds = true;
  for (let k = 1; k <= 30; k++) {
    w.moveGrab([pt[0], pt[1] + (10 * k) / 30, pt[2]]);
    w.step(1 / 60);
    ms = Math.max(ms, maxStretch(b));
    fin = fin && finite(w); bounds = bounds && inBounds(w);
  }
  for (let k = 0; k < 12; k++) { w.step(1 / 60); ms = Math.max(ms, maxStretch(b)); fin = fin && finite(w); }
  const c1 = b.centroid();
  let touching = 0;
  for (let i = 0; i < b.n; i++) if (b.x[3 * i + 1] < 0.05) touching++;
  const gp = w.grab.point;
  check('4. beginGrab on a forehead surface point', ok && w.grab && w.grab.body === b && w.grab.idx.length > 10, `${w.grab.idx.length} particles in the patch`);
  check('4. anchor 10 cm up over 0.5 s lifts the body off the mat', c1[1] - c0[1] > 3 && gp[1] - pt[1] > 8 && touching / b.n < 0.1,
    `grabbed point +${f3(gp[1] - pt[1])} cm, centroid +${f3(c1[1] - c0[1])} cm, ${f3(100 * touching / b.n)} % of particles still touching (the chin tip dangles)`);
  check('4. max edge stretch < 3x, no NaN', ms < 3 && fin && bounds, `max stretch ${f3(ms)}x`);
  w.endGrab();
  let land = false, settle = null;
  for (let t = 0; t < 4; t += 1 / 60) {
    w.step(1 / 60);
    if (yRange(b)[0] <= 1e-6) land = true;
    const ke = w.metrics().kineticUJ;
    if (ke < 1) { if (settle === null) settle = w.time; } else settle = null;
  }
  check('4. after endGrab it falls and settles', w.grab === null && land && settle !== null && finite(w), `KE ${w.metrics().kineticUJ.toExponential(2)} uJ, volume ${f3(w.metrics().volumePct)} %`);
  // bounded reach: an absurd anchor
  b.updateSurface();
  const p2 = [b.surfacePositions[3 * vi], b.surfacePositions[3 * vi + 1], b.surfacePositions[3 * vi + 2]];
  w.beginGrab(b, p2);
  let ms2 = 0, maxV = 0, maxVc = 0;
  let cPrev = b.centroid();
  fin = true; bounds = true;
  for (let k = 0; k < 150; k++) {
    w.moveGrab([500, 900, -700]);
    w.step(1 / 60);
    ms2 = Math.max(ms2, maxStretch(b));
    fin = fin && finite(w); bounds = bounds && inBounds(w);
    for (let i = 0; i < b.v.length; i += 3) maxV = Math.max(maxV, Math.hypot(b.v[i], b.v[i + 1], b.v[i + 2]));
    const c = b.centroid();
    maxVc = Math.max(maxVc, 60 * Math.hypot(c[0] - cPrev[0], c[1] - cPrev[1], c[2] - cPrev[2]));
    cPrev = c;
  }
  const gpt = w.grab.point;
  // the effective anchor is kept inside |x|,|z| <= 28 - grabRadius - 2 = 23 and y <= grabMaxHeight = 30
  const corner = [23, TUNING.grabMaxHeight, -23];
  const reach = Math.hypot(gpt[0] - corner[0], gpt[1] - corner[1], gpt[2] - corner[2]);
  check('4. far anchor does not explode it (bounded reach)', fin && bounds && ms2 < 3 && maxV < 300, `max stretch ${f3(ms2)}x, max particle speed ${f3(maxV)} cm/s, max centroid speed ${f3(maxVc)} cm/s`);
  check('4. far anchor tugs the jelly along to the edge of its reach', reach < 3, `grabbed point at (${gpt.map(f3).join(', ')}), ${f3(reach)} cm from the reach corner`);
  w.endGrab();
  for (let t = 0; t < 4; t += 1 / 60) w.step(1 / 60);
  check('4. released after the far pull, it settles back on the mat', finite(w) && w.metrics().kineticUJ < 1 && yRange(b)[0] < 1e-6, `KE ${w.metrics().kineticUJ.toExponential(2)} uJ`);
  check('4. beginGrab rejects a foreign body / point in the air', !w.beginGrab(new Body(b.geo), p2) && !w.beginGrab(b, [0, 40, 0]));
}

// ---------------------------------------------------------------- 5. 12 random slices
{
  let s = 20240929 >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const w = newWorld({}, 0.3);
  for (let t = 0; t < 1; t += 1 / 60) w.step(1 / 60);
  const V0 = w.bodies[0].restVolume, v0 = w.version;
  let cuts = 0, fin = true, bounds = true, maxMs = 0;
  const msgs = [];
  for (let k = 0; k < 12; k++) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const b of w.bodies) for (let i = 0; i < b.n; i++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], b.x[3 * i + c]); hi[c] = Math.max(hi[c], b.x[3 * i + c]); }
    const p = [0, 1, 2].map((c) => lo[c] + (hi[c] - lo[c]) * rnd());
    const a = rnd() * Math.PI * 2, tilt = (rnd() * 2 - 1) * 0.6;
    let n = [Math.cos(a), tilt, Math.sin(a)];
    const l = Math.hypot(...n);
    n = n.map((v) => v / l);
    const t0 = performance.now();
    const r = w.slice({ n, d: n[0] * p[0] + n[1] * p[1] + n[2] * p[2] }, () => true);
    maxMs = Math.max(maxMs, performance.now() - t0);
    cuts += r.cut;
    msgs.push(r.cut ? `cut ${r.cut}` : r.message || 'miss');
    for (let i = 0; i < 20; i++) { w.step(1 / 60); fin = fin && finite(w); bounds = bounds && inBounds(w); }
  }
  let invalid = [], total = 0, minTet = Infinity, worstTurn = 0;
  for (const b of w.bodies) {
    const v = validatePiece(b.geo);
    minTet = Math.min(minTet, v.minTetVol);
    total += b.restVolume;
    if (!v.ok) invalid.push(v.problems.join(','));
    const o = b.geo.outline, n = o.length / 2;
    for (let i = 0; i < n; i++) {
      const h = (i + n - 1) % n, j = (i + 1) % n;
      const ax = o[2 * i] - o[2 * h], ay = o[2 * i + 1] - o[2 * h + 1], bx = o[2 * j] - o[2 * i], by = o[2 * j + 1] - o[2 * i + 1];
      worstTurn = Math.min(worstTurn, (ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by)));
    }
  }
  check('5. every piece outline stays convex (splitConvex relies on it)', worstTurn > -1e-6, `worst turn sin ${worstTurn.toExponential(2)}`);
  console.log(`      slices: ${msgs.join(' | ')}`);
  check('5. slicing happened', cuts >= 6 && w.bodies.length === cuts + 1 && w.version > v0, `${cuts} body cuts -> ${w.bodies.length} pieces, slowest slice call ${f3(maxMs)} ms`);
  check('5. every piece: positive rest tets, closed outward surface, exact embedding', invalid.length === 0, invalid.length ? invalid.slice(0, 3).join(' | ') : `min tet ${f3(minTet)} cm^3`);
  check('5. finite state, floor and walls respected', fin && bounds);
  check('5. total rest volume within 6 % of the original', total / V0 >= 0.94 && total / V0 <= 1.0 + 1e-9, `${f3(100 * total / V0)} %`);
  let fin2 = true, bounds2 = true;
  for (let t = 0; t < 5; t += 1 / 60) { w.step(1 / 60); fin2 = fin2 && finite(w); bounds2 = bounds2 && inBounds(w); }
  const m = w.metrics();
  check('5. then 5 s of stepping stays finite and settles', fin2 && bounds2 && m.kineticUJ < 1, `KE ${m.kineticUJ.toExponential(2)} uJ, volume ${f3(m.volumePct)} %, ${m.pieces} pieces, ${m.particles} particles`);
}

// ---------------------------------------------------------------- 6. friction
{
  const w = newWorld({}, 0.3);
  const b = w.bodies[0];
  for (let t = 0; t < 2; t += 1 / 60) w.step(1 / 60);
  const c0 = b.centroid();
  for (let i = 0; i < b.n; i++) b.v[3 * i] += 40; // shove sideways at 40 cm/s
  const xs = [];
  for (let t = 0; t < 3; t += 1 / 60) { w.step(1 / 60); xs.push(b.centroid()[0] - c0[0]); }
  const peak = Math.max(...xs);
  check('6. a piece shoved sideways on the mat slows and stops', Math.abs(xs[179] - xs[119]) < 0.01 && w.metrics().kineticUJ < 1 && peak < 3,
    `max travel ${f3(peak)} cm, final offset ${f3(xs[179])} cm, drift over the last second ${Math.abs(xs[179] - xs[119]).toExponential(2)} cm`);
  // a small slice piece nudged repeatedly still stops
  w.slice({ n: [1, 0, 0], d: 2.2 }, () => true);
  const piece = w.bodies.reduce((a, c) => (c.totalMass < a.totalMass ? c : a));
  for (let k = 0; k < 3; k++) { w.nudge(); for (let t = 0; t < 0.5; t += 1 / 60) w.step(1 / 60); }
  const pc = piece.centroid();
  for (let t = 0; t < 2; t += 1 / 60) w.step(1 / 60);
  const pc2 = piece.centroid();
  check('6. nudged pieces come to rest', Math.hypot(pc2[0] - pc[0], pc2[2] - pc[2]) < 1 && w.metrics().kineticUJ < 1, `${w.bodies.length} pieces, KE ${w.metrics().kineticUJ.toExponential(2)} uJ`);
}

// ---------------------------------------------------------------- 7. performance
{
  const w = newWorld({}, 0.3);
  for (let i = 0; i < 60; i++) w.step(1 / 60);
  let t0 = performance.now();
  for (let i = 0; i < 180; i++) w.step(1 / 60);
  const one = (performance.now() - t0) / 180;
  // 12 pieces: 3 strips x 4
  const w12 = newWorld({}, 0.3);
  for (let i = 0; i < 30; i++) w12.step(1 / 60);
  for (const d of [-1.6, 1.6]) { w12.slice({ n: [1, 0, 0], d }, () => true); for (let i = 0; i < 10; i++) w12.step(1 / 60); }
  for (const d of [-2.9, 0.1, 3.1]) { w12.slice({ n: [0, 0, 1], d }, () => true); for (let i = 0; i < 10; i++) w12.step(1 / 60); }
  // top up to exactly 12 by halving the largest piece. The stroke must span only that piece (like a real knife
  // stroke): with accept = always true the infinite plane also cut a neighbour and overshot to 13 pieces.
  const onBody = (b) => (x, y, z) => {
    for (let i = 0; i < b.n; i++) if (Math.hypot(b.x[3 * i] - x, b.x[3 * i + 1] - y, b.x[3 * i + 2] - z) < 0.5) return true;
    return false;
  };
  let guard = 0;
  let s = 99;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  while (w12.bodies.length < 12 && guard++ < 40) {
    const b = w12.bodies.reduce((a, c) => (c.restVolume > a.restVolume ? c : a));
    const c = b.centroid(), a = rnd() * Math.PI;
    w12.slice({ n: [Math.cos(a), 0, Math.sin(a)], d: Math.cos(a) * c[0] + Math.sin(a) * c[2] }, onBody(b));
    for (let i = 0; i < 10; i++) w12.step(1 / 60);
  }
  for (let i = 0; i < 60; i++) w12.step(1 / 60);
  t0 = performance.now();
  for (let i = 0; i < 180; i++) w12.step(1 / 60);
  const twelve = (performance.now() - t0) / 180;
  const m = w12.metrics();
  check('7. single body step(1/60) <= 4 ms average', one <= 4, `${f3(one)} ms`);
  check('7. 12 pieces step(1/60) <= 12 ms average', w12.bodies.length === 12 && twelve <= 12, `${w12.bodies.length} pieces, ${m.particles} particles, ${m.tets} tets: ${f3(twelve)} ms`);
}

// ---------------------------------------------------------------- invariants and API behaviour
{
  // NaN guard
  const w = newWorld({}, 0.3);
  const b = w.bodies[0];
  for (let t = 0; t < 1; t += 1 / 60) w.step(1 / 60);
  const c = b.centroid();
  b.x[3 * 10 + 1] = NaN;
  b.v[3 * 20] = Infinity;
  w.step(1 / 60);
  const c2 = b.centroid();
  check('NaN guard: rebuilt at rest pose around the last finite centroid', finite(w) && Math.hypot(c2[0] - c[0], c2[2] - c[2]) < 0.5 && inBounds(w) && Math.abs(yRange(b)[1] - yRange(b)[0] - restHeight(b)) < 0.2,
    `centroid moved ${f3(Math.hypot(c2[0] - c[0], c2[2] - c[2]))} cm`);
  for (let t = 0; t < 2; t += 1 / 60) w.step(1 / 60);
  check('NaN guard: then settles normally', finite(w) && w.metrics().kineticUJ < 1);

  // slice messages
  const v0 = w.version;
  const miss = w.slice({ n: [1, 0, 0], d: 20 }, () => true);
  check('slice: a miss changes nothing', miss.cut === 0 && miss.message === '' && w.version === v0 && miss.pieces === 1);
  // The blade plane x = 0.3 crosses the face from chin (world z ~ +6) to forehead (z ~ -6); a stroke that only
  // spans z < 1 covers part of the crossings. (An earlier version used accept = x < 3, which every crossing
  // on x = 0.3 passes: the body was really cut and the following slice checks ran on the wrong pieces.)
  const partial = w.slice({ n: [1, 0, 0], d: 0.3 }, (x, y, z) => z < 1);
  check('slice: stroke not across the piece', partial.cut === 0 && partial.pieces === 1 && w.version === v0 && partial.message === 'Swipe all the way across a piece to cut it.', JSON.stringify(partial));
  const along = w.slice({ n: [0, 1, 0], d: 1.3 }, () => true);
  check('slice: horizontal cut runs along the jelly', along.cut === 0 && along.message === 'That cut runs along the jelly, not through it.', along.message);
  const edge = w.slice({ n: [1, 0, 0], d: 4.3 }, () => true);
  check('slice: sliver is too thin', edge.cut === 0 && edge.message === 'Too thin to slice.', edge.message);
  // result semantics: cut = bodies cut by this call, pieces = bodies in the world afterwards
  const ok = w.slice({ n: [Math.cos(0.3), 0, Math.sin(0.3)], d: 0.2 }, () => true);
  check('slice: a clean cut makes two pieces moving apart', ok.cut === 1 && ok.pieces === 2 && ok.message === '' && w.version === v0 + 1, JSON.stringify(ok));
  const [pa, pb] = w.bodies;
  const va = pa.v.reduce((s, v, i) => (i % 3 === 0 ? s + v : s), 0) / pa.n, vb = pb.v.reduce((s, v, i) => (i % 3 === 0 ? s + v : s), 0) / pb.n;
  check('slice: wedge velocities of +/-10 cm/s along the blade normal', Math.abs(Math.abs(va - vb) - 20 * Math.cos(0.3)) < 2, `vx ${f3(va)} / ${f3(vb)} cm/s`);
  for (let t = 0; t < 2; t += 1 / 60) w.step(1 / 60);
  // Pieces separated, not interpenetrating. Contact is volumetric: particles are kept contactSkin outside the
  // other piece's surface, so the closest particle pair may sit anywhere from about the skin up to the cut gap.
  // (The old particle-to-particle contact needed > 0.45 cm here; that threshold no longer applies.)
  let minD = Infinity;
  for (let i = 0; i < pa.surfIdx.length; i++) {
    const a = 3 * pa.surfIdx[i];
    for (let j = 0; j < pb.surfIdx.length; j++) {
      const q = 3 * pb.surfIdx[j];
      minD = Math.min(minD, Math.hypot(pa.x[a] - pb.x[q], pa.x[a + 1] - pb.x[q + 1], pa.x[a + 2] - pb.x[q + 2]));
    }
  }
  const inAB = particlesInside(pa, pb) + particlesInside(pb, pa);
  check('slice: fresh pieces separate (no particle inside the other piece, gap between skin and 1.2 cm)', inAB === 0 && minD > TUNING.contactSkin && minD < 1.2,
    `${inAB} particles inside the other piece; closest particles ${f3(minD)} cm (cut gap ${TUNING.cutGap} cm, contact skin ${TUNING.contactSkin} cm)`);
  // body limit
  const wl = new World();
  wl.relief = relief;
  const small = G.buildPiece(G.roundPolygon(Float64Array.from([-1.5, -1.5, 1.5, -1.5, 1.5, 1.5, -1.5, 1.5]), 0.8), relief);
  for (let k = 0; k < 24; k++) {
    const bb = new Body(small);
    bb.placeFaceUp(0);
    for (let i = 0; i < bb.n; i++) { bb.x[3 * i] += (k % 6) * 4 - 10; bb.x[3 * i + 2] += Math.floor(k / 6) * 4 - 6; }
    bb.p.set(bb.x);
    wl.bodies.push(bb);
  }
  wl.version++;
  const full = wl.slice({ n: [1, 0, 0], d: -10 }, () => true);
  check('slice: at most 24 bodies', full.cut === 0 && full.message === 'That is plenty of pieces. Reset to pour a fresh one.' && wl.bodies.length === 24, full.message);

  // remold with transfer of motion
  const wr = newWorld({}, 0.3);
  for (let t = 0; t < 1; t += 1 / 60) wr.step(1 / 60);
  wr.slice({ n: [1, 0, 0], d: 0.4 }, () => true);
  for (let t = 0; t < 1; t += 1 / 60) wr.step(1 / 60);
  const cs = wr.bodies.map((bb) => bb.centroid());
  const vr = wr.version;
  const t0 = performance.now();
  wr.remold(G.makeRelief({ depth: 1.6, emboss: 0.3 }));
  const ms = performance.now() - t0;
  const cs2 = wr.bodies.map((bb) => bb.centroid());
  const moved = Math.max(...cs.map((c1, i) => Math.hypot(c1[0] - cs2[i][0], c1[2] - cs2[i][2])));
  let maxV = 0, fin = true;
  for (let t = 0; t < 1; t += 1 / 60) {
    wr.step(1 / 60);
    fin = fin && finite(wr);
    for (const bb of wr.bodies) for (let i = 0; i < bb.v.length; i += 3) maxV = Math.max(maxV, Math.hypot(bb.v[i], bb.v[i + 1], bb.v[i + 2]));
  }
  for (let t = 0; t < 2; t += 1 / 60) wr.step(1 / 60);
  const mr = wr.metrics();
  const hr = yRange(wr.bodies[0])[1];
  check('remold: same pieces, new relief, motion kept, no explosion', wr.bodies.length === 2 && wr.version === vr + 1 && moved < 0.3 && fin && maxV < 150 && mr.kineticUJ < 1 && Math.abs(mr.volumePct - 100) < 3,
    `${f3(ms)} ms for 2 pieces; centroids moved ${f3(moved)} cm; max speed after ${f3(maxV)} cm/s; settled height ${f3(hr)} cm; volume ${f3(mr.volumePct)} %`);

  // poke and quarter-speed stepping
  const wp = newWorld({}, 0.3);
  for (let t = 0; t < 1; t += 1 / 60) wp.step(1 / 60);
  const bp = wp.bodies[0];
  const [, top] = column(bp, 0, 0);
  const ptop = [bp.x[3 * top], bp.x[3 * top + 1], bp.x[3 * top + 2]];
  wp.poke(bp, ptop, [0, -1, 0]);
  const ke = wp.metrics().kineticUJ;
  let dip = 0;
  for (let k = 0; k < 20; k++) { wp.step(1 / 240); dip = Math.max(dip, ptop[1] - bp.x[3 * top + 1]); }
  check('poke: impulse into the surface dents it', ke > 10 && dip > 0.1, `KE ${f3(ke)} uJ, dent ${f3(dip)} cm`);
  const tq = wp.time;
  for (let k = 0; k < 40; k++) wp.step(1 / 60 / 4);
  check('step: accumulator honours quarter speed (dt/4)', Math.abs(wp.time - tq - 40 / 240) < 2 / 600, `${f3(wp.time - tq)} s simulated for 40 frames`);
  const t1 = wp.time;
  wp.step(10);
  check('step: substeps capped per call (no spiral of death)', wp.time - t1 <= 40 / 600 + 1e-9, `${f3(wp.time - t1)} s simulated for step(10)`);
  bp.updateSurface();
  let sf = true;
  for (let i = 0; i < bp.surfacePositions.length; i++) if (!Number.isFinite(bp.surfacePositions[i])) sf = false;
  check('updateSurface writes surfacePositions and bubblePositions', sf && bp.surfacePositions.length === bp.geo.surface.positions.length && bp.bubblePositions.length === bp.geo.bubbles.rest.length && bp.bubblePositions.some((v) => v !== 0));
  // extreme sliders stay stable
  let stable = true;
  for (const [f, d] of [[0, 0], [1, 1], [0, 1], [1, 0]]) {
    const we = newWorld({ firmness: f, damping: d }, 5);
    for (let k = 0; k < 90; k++) { we.step(1 / 60); if (k === 30) we.nudge(); }
    stable = stable && finite(we) && inBounds(we) && Math.abs(we.metrics().volumePct - 100) < 5;
  }
  check('slider extremes (firmness/damping 0 and 1) stay stable', stable);
}

console.log(failures ? `\n${failures} physics check(s) FAILED` : '\nall physics checks passed');
process.exit(failures ? 1 : 0);
