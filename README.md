# Jelly Face

Pick a photo of a face, line it up, and it is poured into a 3D jelly lying on a cutting mat.
Pull it, poke it, slice it into pieces, and watch it wobble.

**Live page:** https://mhd-az100.github.io/jelly-face/

## What you can do

- **Choose a face photo** (or drop / paste an image). An align dialog lets you drag, zoom and rotate
  the photo onto eye and mouth guides, then **Pour jelly**.
- **Hand tool:** drag the jelly to pull it, tap to poke, drag the background to turn the view.
- **Knife tool:** swipe all the way across a piece to slice it. Each piece keeps its part of the face.
- Tune **Firmness** (in Bloom), **Internal damping**, **Face depth**, **Photo emboss**, **Clarity** and **Flavor**.
- Live readouts: mass (g), volume (% of rest), kinetic energy (µJ), pieces.

Photos are read locally in the browser with the File API. Nothing is uploaded or stored.

## How it works

- **Soft body:** the jelly is a tetrahedral mesh (about 600 particles and 2,300 tetrahedra) simulated with
  XPBD: 10 substeps per frame, edge and volume constraints, internal damping, mat friction and contact
  between pieces.
- **Slicing:** a knife stroke defines a plane through the camera. It is mapped back to the jelly's rest
  shape, the outline is split, new corners are rounded, and each piece is remeshed and given the old motion.
- **Surface:** a finer render mesh is pinned to the tetrahedra with barycentric weights. The photo is printed
  on the front; cut faces and rims are clear gelatin.
- **Rendering:** three.js (WebGL 2) with a physical material: transmission, thickness, attenuation and clearcoat.

## Project layout

| Path | Contents |
|---|---|
| `src/geom.js` | Face outline and relief, polygon splitting, tetrahedral and surface meshing, embedding |
| `src/physics.js` | XPBD world: stepping, grab, poke, nudge, slice, remold, metrics |
| `src/render.js` | three.js stage: cutting mat, lighting, jelly material, picking, knife plane |
| `src/app.js` | UI: photo picker and align dialog, controls, pointer input, readouts |
| `src/shell.html` | Page markup and styles |
| `build.mjs` | Bundles `src/` into one HTML file |
| `docs/index.html` | Built page served by GitHub Pages |
| `test/` | Node tests for geometry and physics |
| `tools/shot.mjs` | Headless Chrome screenshot harness |

## Develop

Requires Node 20+.

```sh
npm install
node build.mjs                 # writes dist/ and docs/index.html
node test/geom.test.mjs        # geometry checks
node test/physics.test.mjs     # physics checks (~30 s)
```

Open `docs/index.html` in a browser to try it locally (it loads three.js and fonts from CDNs).
`tools/shot.mjs` expects Google Chrome at the default macOS location.
