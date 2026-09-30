// Frame-loop soak after several slices (SPEC §8): no NaN, no performance collapse. Run:
//   node tools/shot.mjs --script tools/scenarios/perf.mjs --size 1280x860 --scheme light --wait 3000 --out shots/int-perf.png
// SwiftShader makes rendering slow (~1 s/frame at this size), so the in-browser step benchmark is the meaningful
// physics number; the rAF soak checks that the real loop keeps running and stays finite.
export default async function perf(page, ctx) {
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const R = {};
  R.bench1 = await ev(() => {
    const W = window.__jellyFace.world;
    for (let i = 0; i < 120; i++) W.step(1 / 60);
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) W.step(1 / 60);
    return { bodies: W.bodies.length, msPerStep: (performance.now() - t0) / 120 };
  });
  // slices across the whole stage at several angles
  R.slices = await ev(async () => {
    const J = window.__jellyFace, W = J.world;
    const f = document.getElementById('stage-frame').getBoundingClientRect();
    const L = f.left + 6, Rr = f.right - 6, T = f.top + 60, B = f.bottom - 6;
    const X = (u) => f.left + u * f.width, Y = (v) => f.top + v * f.height;
    const strokes = [
      [L, Y(0.52), Rr, Y(0.5)], [X(0.5), T, X(0.52), B], [L, Y(0.3), Rr, Y(0.75)],
      [L, Y(0.72), Rr, Y(0.4)], [X(0.38), T, X(0.62), B], [L, Y(0.62), Rr, Y(0.64)], [X(0.62), T, X(0.42), B],
    ];
    const out = [];
    for (const s of strokes) {
      const t0 = performance.now();
      const r = J.sliceScreen(...s);
      out.push({ ...r, ms: +(performance.now() - t0).toFixed(1), toast: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).pop() || '' });
      for (let i = 0; i < 45; i++) W.step(1 / 60);
    }
    return out;
  });
  R.bench2 = await ev(() => {
    const W = window.__jellyFace.world;
    const t0 = performance.now();
    let worst = 0;
    for (let i = 0; i < 120; i++) { const a = performance.now(); W.step(1 / 60); worst = Math.max(worst, performance.now() - a); }
    return { bodies: W.bodies.length, particles: W.metrics().particles, msPerStep: (performance.now() - t0) / 120, worstMs: worst };
  });
  // instrument the real loop and let it run ~8 s
  R.soak = await ev(async () => {
    const J = window.__jellyFace, W = J.world, S = J.stage;
    const acc = { step: [], sync: [], render: [], dts: [] };
    const wrap = (obj, key, bucket) => {
      const orig = obj[key];
      obj[key] = function (...a) { const t = performance.now(); const r = orig.apply(this, a); bucket.push(performance.now() - t); if (key === 'step') acc.dts.push(a[0]); return r; };
      return () => { obj[key] = orig; };
    };
    const un = [wrap(W, 'step', acc.step), wrap(S, 'sync', acc.sync), wrap(S, 'render', acc.render)];
    W.nudge();
    await new Promise((r) => setTimeout(r, 8000));
    un.forEach((f) => f());
    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
    const m = W.metrics();
    return {
      frames: acc.render.length, stepCalls: acc.step.length,
      stepAvgMs: +avg(acc.step).toFixed(2), stepMaxMs: +Math.max(0, ...acc.step).toFixed(2),
      syncAvgMs: +avg(acc.sync).toFixed(2), renderAvgMs: +avg(acc.render).toFixed(1),
      simulatedS: +acc.dts.reduce((s, v) => s + v, 0).toFixed(3),
      finite: W.bodies.every((b) => b.x.every(Number.isFinite) && b.v.every(Number.isFinite)),
      minY: Math.min(...W.bodies.map((b) => { let lo = Infinity; for (let i = 1; i < b.x.length; i += 3) lo = Math.min(lo, b.x[i]); return lo; })),
      metrics: m,
    };
  });
  // settle what the soak left moving
  R.settled = await ev(() => {
    const W = window.__jellyFace.world;
    for (let i = 0; i < 300; i++) W.step(1 / 60);
    return W.metrics();
  });
  await ctx.sleep(2500);
  return R;
}
