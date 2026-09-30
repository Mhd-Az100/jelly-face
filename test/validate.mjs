// Shared checks for PieceGeometry objects (used by geom.test.mjs and physics.test.mjs).

export function tetStats(geo) {
  const P = geo.particles, T = geo.tets;
  let minVol = Infinity, vol = 0;
  for (let t = 0; t < T.length; t += 4) {
    const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2], d = 3 * T[t + 3];
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const e3 = [P[d] - P[a], P[d + 1] - P[a + 1], P[d + 2] - P[a + 2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    const v = (cx * e3[0] + cy * e3[1] + cz * e3[2]) / 6;
    minVol = Math.min(minVol, v);
    vol += v;
  }
  return { minVol, vol };
}

// every undirected edge used by exactly 2 triangles, each directed edge exactly once (consistent orientation),
// no degenerate triangles, Euler characteristic 2 (sphere)
export function surfaceStats(geo) {
  const S = geo.surface, I = S.index, X = S.positions;
  const nv = X.length / 3;
  const dir = new Map();
  let minArea = Infinity, signedVol = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u * nv + v;
      dir.set(k, (dir.get(k) || 0) + 1);
    }
    const ax = X[3 * a], ay = X[3 * a + 1], az = X[3 * a + 2];
    const bx = X[3 * b], by = X[3 * b + 1], bz = X[3 * b + 2];
    const cx = X[3 * c], cy = X[3 * c + 1], cz = X[3 * c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    minArea = Math.min(minArea, 0.5 * Math.hypot(nx, ny, nz));
    signedVol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let badDirected = 0, boundary = 0, undirected = 0;
  for (const [k, cnt] of dir) {
    if (cnt !== 1) badDirected++;
    const u = Math.floor(k / nv), v = k - u * nv;
    const opp = dir.get(v * nv + u) || 0;
    if (opp === 0) boundary++;
    if (u < v || opp === 0) undirected++;
  }
  const used = new Uint8Array(nv);
  for (let i = 0; i < I.length; i++) used[I[i]] = 1;
  let unused = 0;
  for (let i = 0; i < nv; i++) if (!used[i]) unused++;
  const F = I.length / 3;
  const euler = nv - undirected + F;
  return { closed: badDirected === 0 && boundary === 0, badDirected, boundary, minArea, signedVol, euler, unused, nv, F };
}

export function embedError(geo) {
  const P = geo.particles, T = geo.tets, S = geo.surface;
  let maxErr = 0;
  for (let i = 0; i < S.tetOf.length; i++) {
    const t = 4 * S.tetOf[i];
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let q = 0; q < 4; q++) v += S.bary[4 * i + q] * P[3 * T[t + q] + c];
      maxErr = Math.max(maxErr, Math.abs(v - S.positions[3 * i + c]));
    }
  }
  return maxErr;
}

export function edgesUnique(geo) {
  const E = geo.edges, n = geo.particles.length / 3;
  const s = new Set();
  for (let e = 0; e < E.length; e += 2) {
    const a = Math.min(E[e], E[e + 1]), b = Math.max(E[e], E[e + 1]);
    if (a === b) return false;
    s.add(a * n + b);
  }
  return s.size === E.length / 2;
}

export function validatePiece(geo) {
  const ts = tetStats(geo);
  const ss = surfaceStats(geo);
  const emb = embedError(geo);
  const volRatio = ss.signedVol / ts.vol;
  const problems = [];
  if (!(ts.minVol > 0)) problems.push(`non-positive tet (min vol ${ts.minVol})`);
  if (!ss.closed) problems.push(`surface not closed (badDirected ${ss.badDirected}, boundary ${ss.boundary})`);
  if (ss.euler !== 2) problems.push(`euler ${ss.euler}`);
  if (!(ss.minArea > 1e-7)) problems.push(`degenerate triangle ${ss.minArea}`);
  if (ss.unused) problems.push(`${ss.unused} unused surface vertices`);
  if (!(ss.signedVol > 0)) problems.push('surface not outward');
  if (!(emb < 1e-3)) problems.push(`embedding error ${emb}`);
  if (!edgesUnique(geo)) problems.push('duplicate edges');
  if (Math.abs(geo.volume - ts.vol) > 1e-3 * ts.vol) problems.push('geo.volume mismatch');
  return { ok: problems.length === 0, problems, minTetVol: ts.minVol, tetVol: ts.vol, surfVol: ss.signedVol, volRatio, embedErr: emb, minTriArea: ss.minArea };
}
