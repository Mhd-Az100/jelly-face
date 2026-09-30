// Headless-Chrome harness: serves dist/ over http, opens preview.html, reports console output
// and page errors, optionally runs an action script, and saves a screenshot.
//
// usage: node tools/shot.mjs [--out shots/x.png] [--size 1280x860] [--theme light|dark|system]
//                            [--scheme light|dark] [--wait 2500] [--upload path/to/image.png]
//                            [--eval "js expression or statements, may await"] [--full]
//                            [--script tools/scenarios/x.mjs]  (default export async (page, ctx) => result)
// --theme sets data-theme on <html> (the host's explicit toggle); --scheme emulates prefers-color-scheme.
// --eval runs after load+wait inside the page (async function body); its return value is printed as JSON.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const [W, H] = String(args.size || '1280x860').split('x').map(Number);
const out = args.out || 'shots/shot.png';
const wait = Number(args.wait || 2500);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const p = join(root, 'dist', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'preview.html');
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run',
         '--no-default-browser-check', `--window-size=${W},${H}`],
});
let code = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: Number(args.dpr || 1), isMobile: W < 600, hasTouch: W < 600 });
  if (args.scheme) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: args.scheme }]);
  page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => { code = 1; console.log(`[pageerror] ${e.stack || e.message}`); });
  page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`http://127.0.0.1:${port}/preview.html`, { waitUntil: 'networkidle0', timeout: 60000 });
  if (args.theme && args.theme !== 'system') {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), args.theme);
  }
  if (args.upload) {
    const input = await page.$('input[type=file]');
    if (!input) { console.log('[harness] no file input found'); code = 1; }
    else await input.uploadFile(resolve(args.upload));
  }
  await new Promise((r) => setTimeout(r, wait));
  if (args.eval) {
    const result = await page.evaluate(`(async () => { ${args.eval} })()`);
    console.log('[eval] ' + JSON.stringify(result));
    await new Promise((r) => setTimeout(r, Number(args.after || 800)));
  }
  if (args.script) {
    // --script path/to/scenario.mjs: a module whose default export is async (page, ctx) => result.
    // Use it for real input (page.mouse / page.keyboard); ctx.shot(name) saves an extra screenshot.
    const mod = await import(pathToFileURL(resolve(args.script)).href);
    const ctx = {
      root, W, H,
      shot: async (name) => { await page.screenshot({ path: join(root, name) }); console.log(`[harness] saved ${name}`); },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const result = await mod.default(page, ctx);
    console.log('[script] ' + JSON.stringify(result, null, 1));
    await new Promise((r) => setTimeout(r, Number(args.after || 800)));
  }
  await page.screenshot({ path: join(root, out), fullPage: !!args.full });
  console.log(`[harness] saved ${out}`);
} catch (e) {
  code = 1;
  console.log('[harness] ' + (e.stack || e.message));
} finally {
  await browser.close();
  server.close();
  process.exit(code);
}
