// Real-input integration scenario (SPEC §7 interaction). Run:
//   node tools/shot.mjs --script tools/scenarios/interact.mjs --size 1280x860 --scheme light --wait 3000 --out shots/int-interact.png
// Headless SwiftShader draws ~1 frame/s, so the scenario advances physics itself with world.step between inputs.
export default async function interact(page, ctx) {
  const R = { checks: {}, fails: [] };
  const ok = (name, cond, detail) => {
    R.checks[name] = cond ? 'PASS' : 'FAIL';
    if (!cond) R.fails.push(`${name}: ${JSON.stringify(detail)}`);
  };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const step = (n) => ev((k) => { const W = window.__jellyFace.world; for (let i = 0; i < k; i++) W.step(1 / 60); }, n);
  const state = () => ev(() => window.__jellyFace.state());
  const finite = () => ev(() => window.__jellyFace.world.bodies.every((b) => b.x.every(Number.isFinite) && b.v.every(Number.isFinite)));
  const toasts = () => ev(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
  // client px of a world point
  const toClient = (p) => ev((q) => {
    const J = window.__jellyFace, r = document.getElementById('jelly-canvas').getBoundingClientRect();
    const [nx, ny] = J.stage.project(q);
    return [r.left + ((nx + 1) / 2) * r.width, r.top + ((1 - ny) / 2) * r.height];
  }, p);
  const body0 = () => ev(() => {
    const b = window.__jellyFace.world.bodies[0];
    const c = b.centroid([0, 0, 0]);
    let top = -Infinity, low = Infinity;
    for (let i = 0; i < b.n; i++) { top = Math.max(top, b.x[3 * i + 1]); low = Math.min(low, b.x[3 * i + 1]); }
    return { c, top, low };
  });
  const frame = await ev(() => { const r = document.getElementById('stage-frame').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });

  await step(180);

  // ---- Hand: grab near the forehead and pull up/back with real mouse events
  const b0 = await body0();
  const [gx, gy] = await toClient([b0.c[0], b0.top, b0.c[2] - 3]);
  const pk = await ev((x, y) => { const h = window.__jellyFace.pickScreen(x, y); return h ? { point: h.point, normal: h.normal } : null; }, gx, gy);
  ok('pick hits the jelly', !!pk, { gx, gy });
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  const g0 = await ev(() => { const g = window.__jellyFace.world.grab; return g ? { point: [...g.point], anchor: [...g.anchor] } : null; });
  ok('pointerdown on jelly begins a grab', !!g0, g0);
  let maxPointY = -Infinity;
  for (let k = 1; k <= 12; k++) {
    await page.mouse.move(gx, gy - 14 * k, { steps: 2 });
    await step(4);
    const p = await ev(() => { const g = window.__jellyFace.world.grab; return g ? g.point[1] : NaN; });
    maxPointY = Math.max(maxPointY, p);
  }
  await step(40);
  const gHeld = await ev(() => { const g = window.__jellyFace.world.grab; return g ? { point: [...g.point], anchor: [...g.anchor] } : null; });
  const bHeld = await body0();
  R.grab = { start: g0, held: gHeld, maxPointY, restTop: b0.top, heldTop: bHeld.top, heldLow: bHeld.low, cy0: b0.c[1], cyHeld: bHeld.c[1] };
  // Dragging up on screen moves the target in the camera-facing plane (up and away at 55 deg elevation).
  const moved = gHeld ? Math.hypot(gHeld.point[0] - g0.point[0], gHeld.point[1] - g0.point[1], gHeld.point[2] - g0.point[2]) : 0;
  const lag = gHeld ? Math.hypot(gHeld.point[0] - gHeld.anchor[0], gHeld.point[1] - gHeld.anchor[1], gHeld.point[2] - gHeld.anchor[2]) : 99;
  R.grab.moved = moved;
  R.grab.lag = lag;
  ok('grab drags the grabbed point along (> 3 cm, lifted > 1.5 cm)', moved > 3 && gHeld.point[1] > g0.point[1] + 1.5, R.grab);
  ok('grabbed point follows the pointer anchor (< 1.5 cm lag)', lag < 1.5, R.grab);
  ok('body stays on or above the mat while pulled', bHeld.low >= -1e-4, R.grab);
  ok('grab keeps state finite', await finite(), null);
  await ctx.shot('shots/int-grab.png');
  await page.mouse.up();
  const gAfter = await ev(() => window.__jellyFace.world.grab);
  ok('pointerup ends the grab', gAfter === null, gAfter);
  await step(180);
  const bRest = await body0();
  const m1 = (await state()).metrics;
  R.afterDrop = { low: bRest.low, cy: bRest.c[1], ke: m1.kineticUJ };
  ok('falls back and settles after release', bRest.low >= -1e-4 && bRest.c[1] < b0.c[1] + 1 && m1.kineticUJ < 5, R.afterDrop);

  // ---- Tap to poke
  const [tx, ty] = await toClient([b0.c[0], b0.top, b0.c[2]]);
  await page.mouse.click(tx, ty);
  const kePoke = (await state()).metrics.kineticUJ;
  R.pokeKE = kePoke;
  ok('tap pokes (kinetic energy jumps)', kePoke > 50, kePoke);
  await step(120);

  // ---- Orbit by dragging the background, reset view, wheel zoom
  const v0 = await ev(() => window.__jellyFace.stage.view);
  await page.mouse.move(frame[0] + 40, frame[3] - 40);
  await page.mouse.down();
  await page.mouse.move(frame[0] + 140, frame[3] - 60, { steps: 5 });
  await page.mouse.up();
  const v1 = await ev(() => window.__jellyFace.stage.view);
  R.orbit = { az0: v0.azimuth, az1: v1.azimuth, el0: v0.elevation, el1: v1.elevation };
  ok('background drag orbits the camera', Math.abs(v1.azimuth - v0.azimuth) > 0.2, R.orbit);
  await page.click('#btn-recenter');
  const v2 = await ev(() => window.__jellyFace.stage.view);
  ok('Reset view restores the default camera', Math.abs(v2.azimuth) < 1e-9 && Math.abs(v2.elevation - v0.elevation) < 1e-9, v2);
  await page.mouse.move((frame[0] + frame[2]) / 2, (frame[1] + frame[3]) / 2);
  await page.mouse.wheel({ deltaY: -300 });
  const v3 = await ev(() => window.__jellyFace.stage.view);
  ok('wheel up zooms in', v3.distance < v2.distance, { before: v2.distance, after: v3.distance });
  await page.click('#btn-recenter');

  // ---- Keyboard shortcuts (focus on the page body first)
  await page.mouse.click(5, 5);
  await page.keyboard.press('k');
  ok('K selects the knife', (await state()).tool === 'knife', null);
  await page.keyboard.press('m');
  ok('M shows the mesh', (await state()).showMesh === true, null);
  await page.keyboard.press('Space');
  ok('Space pauses', (await state()).paused === true, null);
  await page.keyboard.press('Space');
  ok('Space resumes', (await state()).paused === false, null);
  const keN0 = (await state()).metrics.kineticUJ;
  await page.keyboard.press('n');
  const keN1 = (await state()).metrics.kineticUJ;
  ok('N nudges', keN1 > keN0 + 100, { keN0, keN1 });
  await step(180);

  // ---- Knife with real pointer events (one body on the mat)
  const piecesBefore = (await state()).bodies;
  // a stroke that starts on the jelly does not cut and says why
  const bIn = await body0();
  const [ix, iy] = await toClient(bIn.c);
  await page.mouse.move(ix, iy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(ix + ((frame[2] - 6 - ix) * i) / 8, iy);
  await page.mouse.up();
  const tIn = (await toasts()).pop() || '';
  ok('stroke starting on the jelly does not cut and toasts', tIn === 'Swipe all the way across a piece to cut it.' && (await state()).bodies === piecesBefore, tIn);
  // a stroke that misses every piece gets a hint toast instead of silence
  await page.mouse.move(frame[0] + 12, frame[3] - 40);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(frame[0] + 12 + 30 * i, frame[3] - 36);
  await page.mouse.up();
  const tMiss = (await toasts()).pop() || '';
  ok('missed stroke shows a hint toast', /^Missed the jelly/.test(tMiss) && (await state()).bodies === piecesBefore, tMiss);
  // a full stroke across the whole stage cuts it
  const bK = await body0();
  const [, ky] = await toClient(bK.c);
  await page.mouse.move(frame[0] + 6, ky);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(frame[0] + 6 + ((frame[2] - frame[0] - 12) * i) / 16, ky + i * 0.5);
  await page.mouse.up();
  const sK = await state();
  R.knife = { before: piecesBefore, after: sK.bodies, version: sK.version, toasts: await toasts() };
  ok('knife drag slices the jelly', sK.bodies === piecesBefore + 1, R.knife);
  await step(60);
  // a short stroke (< 24 px) does nothing
  await page.mouse.move(frame[0] + 300, frame[1] + 300);
  await page.mouse.down();
  await page.mouse.move(frame[0] + 310, frame[1] + 305, { steps: 2 });
  await page.mouse.up();
  ok('stroke shorter than 24 px does not slice', (await state()).bodies === sK.bodies, null);
  ok('successful cut clears stale hint toasts', (await ev(() => [...document.querySelectorAll('#toasts .toast:not(.out)')].length)) === 0, await toasts());
  await page.keyboard.press('h');
  ok('H selects the hand', (await state()).tool === 'hand', null);

  // ---- Switches by clicking their labels
  await page.click('label[for="opt-quarter"]');
  let s = await state();
  ok('¼ speed switch', s.quarter === true, s.quarter);
  await page.click('label[for="opt-quarter"]');
  await page.click('label[for="opt-pause"]');
  s = await state();
  ok('Pause switch', s.paused === true, s.paused);
  const vPause = await ev(() => { const b = window.__jellyFace.world.bodies[0]; return Array.from(b.x.slice(0, 6)); });
  await ctx.sleep(2500);
  const vPause2 = await ev(() => { const b = window.__jellyFace.world.bodies[0]; return Array.from(b.x.slice(0, 6)); });
  ok('paused world does not move', JSON.stringify(vPause) === JSON.stringify(vPause2), { vPause, vPause2 });
  await page.click('label[for="opt-pause"]');
  await page.click('label[for="opt-mesh"]');
  ok('Show mesh switch toggles off', (await state()).showMesh === false, null);
  await page.click('label[for="opt-mesh"]');
  ok('Show mesh switch toggles on', (await ev(() => window.__jellyFace.stage.showMesh)) === true, null);

  // ---- Flavors (click the swatches)
  const flav = {};
  for (const k of ['strawberry', 'lime', 'blueberry', 'peach', 'grape', 'clear', 'strawberry']) {
    await page.click(`#flavor-${k}`);
    flav[k] = await ev(() => [window.__jellyFace.state().flavor, window.__jellyFace.stage.flavor, document.getElementById('flavor-name').textContent]);
  }
  ok('flavor swatches reach the stage', Object.entries(flav).every(([k, v]) => v[0] === k && v[1] === k), flav);

  // ---- Clarity, firmness/damping extremes, depth/emboss remold via keyboard on the ranges
  await page.focus('#clarity');
  await page.keyboard.press('End');
  ok('clarity reaches the stage', (await ev(() => window.__jellyFace.stage.clarity)) === 1, null);
  await page.keyboard.press('Home');
  ok('clarity 0', (await ev(() => window.__jellyFace.stage.clarity)) === 0, null);
  await page.keyboard.press('End');
  for (const [id, key] of [['firmness', 'Home'], ['damping', 'Home'], ['firmness', 'End'], ['damping', 'End']]) {
    await page.focus(`#${id}`);
    await page.keyboard.press(key);
    await ev(() => window.__jellyFace.world.nudge());
    await step(90);
  }
  s = await state();
  ok('slider extremes stay finite', await finite(), s.params);
  ok('firmness/damping written to world.params', s.params.firmness === 1 && s.params.damping === 1, s.params);
  const ver0 = s.version;
  await page.focus('#depth');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await ctx.sleep(400);
  await page.focus('#emboss');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await ctx.sleep(400);
  await step(60);
  s = await state();
  R.remold = { ver0, ver1: s.version, depth: s.depth, emboss: s.emboss, bodies: s.bodies };
  ok('depth/emboss remold the jelly', s.version > ver0 && s.depth > 1 && s.emboss > 0.3, R.remold);
  ok('remold keeps pieces', s.bodies === sK.bodies, R.remold);
  ok('remold state finite', await finite(), null);
  await page.focus('#depth');
  await page.keyboard.press('End');
  await page.focus('#emboss');
  await page.keyboard.press('End');
  await ctx.sleep(400);
  await step(120);
  ok('max depth + emboss stays finite', await finite(), await state());

  // ---- R pours again
  await page.mouse.click(5, 5);
  await page.keyboard.press('r');
  s = await state();
  ok('R pours a fresh single jelly', s.bodies === 1, s.bodies);
  await step(200);
  await ctx.sleep(2500);
  R.final = await state();
  return R;
}
