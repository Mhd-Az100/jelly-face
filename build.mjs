// Assembles src/*.js + src/shell.html into one self-contained artifact page.
//   dist/jelly-face.html  -> the artifact body (no doctype/html/head/body: the host adds the skeleton)
//   dist/preview.html     -> the same page wrapped in a skeleton like the host's, for local testing
//   docs/index.html       -> copy of preview.html served by GitHub Pages (main branch, /docs)
//
// Module conventions (enforced here, see SPEC.md §2):
//   - exports:   only `export function NAME`, `export class NAME`, `export const|let NAME`
//   - sibling imports: `import { a, b as c } from './geom.js';` or `import * as G from './geom.js';`
//   - three imports: `import * as THREE from 'three';` and `import { X } from 'three/addons/...';`
// Each module is wrapped in its own function scope, so top-level names never collide.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ORDER = ['geom', 'physics', 'render', 'app'];

const hoisted = new Set();
const wrapped = [];

for (const name of ORDER) {
  let src = readFileSync(join(root, 'src', `${name}.js`), 'utf8');
  const exportNames = [];

  // three / addon imports: hoist to the top of the combined module.
  src = src.replace(/^import\s[^;]*?from\s*['"](three(?:\/addons\/[^'"]+)?)['"];?[ \t]*$/gms, (m) => {
    hoisted.add(m.replace(/\s+/g, ' ').trim().replace(/;?$/, ';'));
    return '';
  });

  // sibling imports -> destructure from the wrapped module object.
  src = src.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s*['"]\.\/(\w+)\.js['"];?[ \t]*$/gm,
    (_, alias, mod) => `const ${alias} = __mod_${mod};`);
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/(\w+)\.js['"];?[ \t]*$/gms, (_, names, mod) => {
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'));
    return `const { ${parts.join(', ')} } = __mod_${mod};`;
  });

  if (/^import\s/m.test(src)) throw new Error(`${name}.js: unsupported import form:\n` + src.match(/^import\s.*$/m)[0]);

  src = src.replace(/^export\s+(async\s+function\*?|function\*?|class|const|let)\s+(\w+)/gm, (_, kw, id) => {
    exportNames.push(id);
    return `${kw} ${id}`;
  });
  if (/^export\s/m.test(src)) throw new Error(`${name}.js: unsupported export form:\n` + src.match(/^export\s.*$/m)[0]);

  wrapped.push(
    `// ---- ${name}.js ----\nconst __mod_${name} = (() => {\n${src}\nreturn { ${exportNames.join(', ')} };\n})();`
  );
}

const moduleScript = [...hoisted].join('\n') + '\n\n' + wrapped.join('\n\n');
const shell = readFileSync(join(root, 'src', 'shell.html'), 'utf8');
if (!shell.includes('<!--APP_SCRIPT-->')) throw new Error('shell.html must contain <!--APP_SCRIPT-->');
if (/<!doctype|<html|<head|<body/i.test(shell)) throw new Error('shell.html must not contain doctype/html/head/body tags');

const THREE_VERSION = '0.170.0';
const importMap = `<script type="importmap">${JSON.stringify({
  imports: {
    three: `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`,
    'three/addons/': `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/`,
  },
})}</script>`;
const page = shell.replace('<!--APP_SCRIPT-->',
  () => `${importMap}\n<script type="module">\n${moduleScript}\n</script>`);
writeFileSync(join(root, 'dist', 'jelly-face.html'), page);

// Approximation of the host skeleton (charset + viewport-fit=cover + small reset).
const preview = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px/1.45 system-ui,-apple-system,sans-serif;background:#fafaf9}
img{max-width:100%}[hidden]{display:none!important}
</style></head><body>
${page}
</body></html>`;
writeFileSync(join(root, 'dist', 'preview.html'), preview);

mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'index.html'), preview);
writeFileSync(join(root, 'docs', '.nojekyll'), '');

console.log(`built dist/jelly-face.html (${(page.length / 1024).toFixed(1)} KB)`);
