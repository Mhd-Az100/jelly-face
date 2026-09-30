// render.js — three.js stage for Jelly Face (SPEC §6).
//
// World frame: centimetres, y up, cutting-mat top at y = 0. The stage never simulates anything; it reads
// World/Body state (SPEC §5) every frame and draws it:
//   body.geo.surface.{index, uvs} + body.surfacePositions (after body.updateSurface())  -> jelly mesh
//   body.bubblePositions + body.geo.bubbles.r                                          -> bubble instances
//   body.x + body.geo.edges                                                            -> tet-edge wireframe
//   world.bodies, world.version                                                        -> rebuild trigger
//
// API (all coordinates world cm; NDC = [-1, 1] with +y up):
//   createStage(canvas) -> stage          throws Error('webgl2') when WebGL2 is unavailable
//   stage.setTheme({ isDark, bg, floor, ink, accent })   CSS colour strings
//   stage.setFaceTexture(canvas)          800x1000 canvas over FACE.box (same canvas again = re-upload)
//   stage.setFlavor(key) / setClarity(0..1) / setShowMesh(bool)
//   stage.sync(world); stage.render(); stage.resize(cssW, cssH, dpr)
//   stage.pick(ndcX, ndcY) -> { body, point:[x,y,z], normal:[x,y,z] } | null
//   stage.ray(ndcX, ndcY) -> { origin, dir }; stage.viewDir(); stage.project([x,y,z]) -> [ndcX, ndcY]
//   stage.bladePlane(ndcA, ndcB) -> { n, d, accept(x,y,z) }   (ndcA/ndcB: [x, y] or {x, y})
//   stage.orbit(dAz, dEl)  +dAz swings the camera toward +x, +dEl raises it (elevation clamped 12..88 deg)
//   stage.zoom(factor)     factor > 1 moves the camera closer (distance /= factor), clamped
//   stage.resetView(); stage.flashCut(ndcA, ndcB); stage.dispose()
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FACE } from './geom.js';

const DEG = Math.PI / 180;

// Flavour presets: `color` multiplies the photo (kept light), attenuation tints light travelling
// through the gel. Distances are long enough that a 2.5 cm path tints without drowning the face; the cool
// flavors get longer ones so they don't cancel the warm skin tones into grey.
const FLAVORS = {
  clear:      { color: '#ffffff', atten: '#fff4ec', dist: 7 },
  strawberry: { color: '#ffc2cb', atten: '#d81b3f', dist: 10 },
  lime:       { color: '#d8f7b5', atten: '#4aa323', dist: 20 },
  blueberry:  { color: '#c9d8ff', atten: '#2e58d6', dist: 20 },
  peach:      { color: '#ffe0c2', atten: '#ee8a3a', dist: 10 },
  grape:      { color: '#e5cbff', atten: '#7c34c6', dist: 14 },
};

const VIEW = {
  fov: 32,
  elevation: 55 * DEG,
  target: [0, 1.2, 0],
  minEl: 12 * DEG, maxEl: 88 * DEG,
  minZoom: 0.42, maxZoom: 2.6,     // distance scale relative to the aspect-fitted default
  fillH: 0.7, fillW: 0.8,          // bbox incl. relief; the visible face then fills ~60 % of the height
};

// Cutting mat footprint (world cm). The far edge sits just beyond the forehead so its numerals show
// in the default view; physics walls are at |x|,|z| <= 28.
const MAT = { x0: -30, x1: 30, z0: -11.5, z1: 29, thick: 0.12, radius: 1.8, texW: 2048 };

const DEFAULT_THEME = { isDark: false, bg: '#DADFE3', floor: '#CBD2D8', ink: '#15181C', accent: '#B3214D' };

// Per-theme light rig. envJelly/envSet are per-material env-map intensities (reflections on the gel stay
// strong while the mat is lit mostly by the key + fill so its colour stays close to the floor token).
const LIGHTING = {
  light: { key: 1.6, hemi: 0.5, envJelly: 1.0, envSet: 0.35, shadow: 0.45, matLift: 0 },
  dark:  { key: 2.5, hemi: 0.65, envJelly: 1.25, envSet: 0.32, shadow: 0.42, matLift: 0.2 },
};

const FLASH_MS = 480;
const FLASH_MAX_SEG = 4096;
const FLASH_HALF_WIDTH = 0.05;     // cm

function hasWebGL2() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (e) {
    return false;
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function ndcXY(p, out) {
  if (Array.isArray(p) || ArrayBuffer.isView(p)) { out.x = +p[0]; out.y = +p[1]; }
  else if (p) { out.x = +p.x; out.y = +p.y; }
  else { out.x = 0; out.y = 0; }
  if (!Number.isFinite(out.x)) out.x = 0;
  if (!Number.isFinite(out.y)) out.y = 0;
  return out;
}

// Area-weighted smooth normals straight on typed arrays (no allocations).
function computeNormals(pos, idx, nrm) {
  nrm.fill(0);
  for (let t = 0, tl = idx.length; t < tl; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const e1x = pos[b] - ax, e1y = pos[b + 1] - ay, e1z = pos[b + 2] - az;
    const e2x = pos[c] - ax, e2y = pos[c + 1] - ay, e2z = pos[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
  }
  for (let i = 0, il = nrm.length; i < il; i += 3) {
    const x = nrm[i], y = nrm[i + 1], z = nrm[i + 2];
    const l2 = x * x + y * y + z * z;
    if (l2 > 1e-24) {
      const inv = 1 / Math.sqrt(l2);
      nrm[i] = x * inv; nrm[i + 1] = y * inv; nrm[i + 2] = z * inv;
    } else {
      nrm[i] = 0; nrm[i + 1] = 1; nrm[i + 2] = 0;
    }
  }
}

// Cheap change detector for body state, so a paused world costs no surface/normal work.
function stamp(x) {
  let s = 0, w = 0;
  for (let i = 0, l = x.length; i < l; i++) {
    const v = x[i];
    s += v;
    w += v * ((i & 7) + 1);
  }
  return s + 1.618 * w;
}

function asF32(a) { return a instanceof Float32Array ? a : Float32Array.from(a); }
function asIndex(a) { return (a instanceof Uint32Array || a instanceof Uint16Array) ? a : Uint32Array.from(a); }

export function createStage(canvas) {
  if (!canvas || !hasWebGL2()) throw new Error('webgl2');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    throw new Error('webgl2');
  }
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new Error('webgl2');
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ---------------------------------------------------------------- scene, environment, lights
  const scene = new THREE.Scene();
  const bgColor = new THREE.Color(DEFAULT_THEME.bg);
  scene.background = bgColor;
  scene.fog = new THREE.Fog(bgColor.getHex(), 40, 120);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  const envTex = envRT.texture;
  scene.environment = envTex;

  const hemi = new THREE.HemisphereLight(0xf2f5fa, 0xcbd2d8, LIGHTING.light.hemi);
  scene.add(hemi);

  // Key light: upper left, behind the jelly (world -x, -z), so its shadow falls toward the viewer and the
  // mat seen through the gel (which lies behind the surface point) stays mostly lit.
  const key = new THREE.DirectionalLight(0xfff6ec, LIGHTING.light.key);
  key.position.set(-15, 30, -13);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = -36; sc.right = 36; sc.top = 36; sc.bottom = -36; sc.near = 4; sc.far = 90;
  sc.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.intensity = LIGHTING.light.shadow;
  scene.add(key, key.target);

  // ---------------------------------------------------------------- cutting mat + floor
  const matCanvas = document.createElement('canvas');
  matCanvas.width = MAT.texW;
  matCanvas.height = Math.round(MAT.texW * (MAT.z1 - MAT.z0) / (MAT.x1 - MAT.x0));
  const matTex = new THREE.CanvasTexture(matCanvas);
  matTex.colorSpace = THREE.SRGBColorSpace;
  matTex.anisotropy = maxAniso;
  matTex.generateMipmaps = true;
  matTex.minFilter = THREE.LinearMipmapLinearFilter;

  const matTopMat = new THREE.MeshStandardMaterial({ map: matTex, roughness: 0.82, metalness: 0, envMap: envTex });
  const matSideMat = new THREE.MeshStandardMaterial({ color: 0xaab2ba, roughness: 0.9, metalness: 0, envMap: envTex });
  const matMesh = new THREE.Mesh(buildMatGeometry(), [matTopMat, matSideMat]);
  matMesh.receiveShadow = true;
  matMesh.matrixAutoUpdate = false;
  scene.add(matMesh);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0xc4cad0, roughness: 1, metalness: 0, envMap: envTex });
  const floorGeo = new THREE.PlaneGeometry(1600, 1600);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.y = -MAT.thick - 0.002;
  floor.receiveShadow = true;
  floor.updateMatrix();
  floor.matrixAutoUpdate = false;
  scene.add(floor);

  // ---------------------------------------------------------------- jelly, bubbles, wireframe, overlays
  const jellyMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.08,
    metalness: 0,
    transmission: 0.6,
    thickness: 2.5,
    ior: 1.34,
    attenuationColor: new THREE.Color(FLAVORS.clear.atten),
    attenuationDistance: FLAVORS.clear.dist,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    specularIntensity: 1,
    envMap: envTex,
    side: THREE.FrontSide,
  });
  // The photo is printed on the front cap only. geo.surface.print (per vertex: 1 on the front cap, easing to 0
  // across the front bevel, 0 on the side walls, cut faces and back) fades the map to plain gel and raises the
  // transmission there, so a cut through a feature does not smear it down the new wall.
  jellyMat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float facePrint;\nvarying float vFacePrint;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\n\tvFacePrint = facePrint;');
    shader.fragmentShader = 'varying float vFacePrint;\n' + shader.fragmentShader
      .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace(
        'diffuseColor *= sampledDiffuseColor;', 'diffuseColor *= mix( vec4( 1.0 ), sampledDiffuseColor, clamp( vFacePrint, 0.0, 1.0 ) );'))
      .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment.replace(
        'material.transmission = transmission;', 'material.transmission = mix( max( transmission, 0.9 ), transmission, clamp( vFacePrint, 0.0, 1.0 ) );'));
  };
  jellyMat.customProgramCacheKey = () => 'jelly-face-print';

  const bodiesGroup = new THREE.Group();
  const wiresGroup = new THREE.Group();
  wiresGroup.visible = false;
  scene.add(bodiesGroup, wiresGroup);

  const bubbleGeo = new THREE.SphereGeometry(1, 12, 8);
  const bubbleMat = new THREE.MeshStandardMaterial({
    color: 0xf7faff, roughness: 0.06, metalness: 0.0, emissive: 0xdfe8f2, emissiveIntensity: 0.35, envMap: envTex,
  });
  let bubbleCap = 0;
  let bubbles = null;
  function ensureBubbleCapacity(n) {
    if (bubbles && n <= bubbleCap) return;
    let cap = 64;
    while (cap < n) cap *= 2;
    if (bubbles) {
      scene.remove(bubbles);
      bubbles.dispose();
    }
    bubbles = new THREE.InstancedMesh(bubbleGeo, bubbleMat, cap);
    bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bubbles.frustumCulled = false;
    bubbles.castShadow = false;
    bubbles.receiveShadow = false;
    bubbles.count = 0;
    bubbles.matrixAutoUpdate = false;
    bubbleCap = cap;
    scene.add(bubbles);
  }
  ensureBubbleCapacity(64);

  const wireMat = new THREE.LineBasicMaterial({
    color: DEFAULT_THEME.accent, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, toneMapped: false,
  });

  // Grab marker: a small dot at the hand anchor plus a thread to the grabbed point.
  const markerMat = new THREE.MeshBasicMaterial({
    color: DEFAULT_THEME.accent, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), markerMat);
  marker.visible = false;
  marker.renderOrder = 20;
  marker.frustumCulled = false;
  scene.add(marker);
  const threadGeo = new THREE.BufferGeometry();
  const threadPos = new Float32Array(6);
  threadGeo.setAttribute('position', new THREE.BufferAttribute(threadPos, 3).setUsage(THREE.DynamicDrawUsage));
  const threadMat = new THREE.LineBasicMaterial({
    color: DEFAULT_THEME.accent, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const thread = new THREE.LineSegments(threadGeo, threadMat);
  thread.visible = false;
  thread.renderOrder = 19;
  thread.frustumCulled = false;
  scene.add(thread);

  // Cut flash: camera-facing ribbons along the plane/surface intersection, fading out.
  const flashPos = new Float32Array(FLASH_MAX_SEG * 4 * 3);
  const flashIdx = new Uint32Array(FLASH_MAX_SEG * 6);
  for (let s = 0; s < FLASH_MAX_SEG; s++) {
    const v = s * 4, o = s * 6;
    flashIdx[o] = v; flashIdx[o + 1] = v + 1; flashIdx[o + 2] = v + 2;
    flashIdx[o + 3] = v; flashIdx[o + 4] = v + 2; flashIdx[o + 5] = v + 3;
  }
  const flashGeo = new THREE.BufferGeometry();
  const flashPosAttr = new THREE.BufferAttribute(flashPos, 3).setUsage(THREE.DynamicDrawUsage);
  flashGeo.setAttribute('position', flashPosAttr);
  flashGeo.setIndex(new THREE.BufferAttribute(flashIdx, 1));
  flashGeo.setDrawRange(0, 0);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.visible = false;
  flash.renderOrder = 30;
  flash.frustumCulled = false;
  scene.add(flash);
  let flashStart = 0;

  // ---------------------------------------------------------------- camera
  const camera = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.5, 900);
  const target = new THREE.Vector3(VIEW.target[0], VIEW.target[1], VIEW.target[2]);
  let az = 0, el = VIEW.elevation, zoomScale = 1, baseDist = 32;

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _ndc = new THREE.Vector2();
  const _a = new THREE.Vector2();
  const _b = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const hits = [];

  function placeCamera(azimuth, elevation, dist) {
    const ce = Math.cos(elevation);
    camera.position.set(
      target.x + dist * ce * Math.sin(azimuth),
      target.y + dist * Math.sin(elevation),
      target.z + dist * ce * Math.cos(azimuth),
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
  }

  // Distance that frames the resting face at the default angle for the current aspect.
  function fitBaseDistance() {
    const hw = FACE.W / 2, hh = FACE.H / 2, top = FACE.T + 1.3;
    let d = 32;
    for (let it = 0; it < 5; it++) {
      placeCamera(0, VIEW.elevation, d);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        _v.set(i & 1 ? hw : -hw, i & 2 ? top : 0, i & 4 ? hh : -hh).project(camera);
        if (_v.x < x0) x0 = _v.x; if (_v.x > x1) x1 = _v.x;
        if (_v.y < y0) y0 = _v.y; if (_v.y > y1) y1 = _v.y;
      }
      const s = Math.max((y1 - y0) / 2 / VIEW.fillH, (x1 - x0) / 2 / VIEW.fillW);
      if (!(s > 0) || !Number.isFinite(s)) break;
      d *= s;
    }
    baseDist = clamp(d, 12, 200);
  }

  function updateCamera() {
    const d = baseDist * zoomScale;
    camera.near = Math.max(0.3, d * 0.04);
    camera.far = d + 900;
    camera.updateProjectionMatrix();
    placeCamera(az, el, d);
    scene.fog.near = d + 9;
    scene.fog.far = d + 95;
  }

  // ---------------------------------------------------------------- theme
  let theme = { ...DEFAULT_THEME };
  let lighting = LIGHTING.light;
  const _c1 = new THREE.Color();
  const _white = new THREE.Color(0xffffff);
  const matBase = new THREE.Color();
  const inkColor = new THREE.Color();

  function parseInto(color, str, fallback) {
    const s = typeof str === 'string' ? str.trim() : '';
    if (!s) { color.set(fallback); return color; }
    try {
      if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', s)) { color.set(fallback); return color; }
      _c1.setRGB(NaN, NaN, NaN);
      _c1.setStyle(s);
      if (Number.isFinite(_c1.r) && Number.isFinite(_c1.g) && Number.isFinite(_c1.b)) color.copy(_c1);
      else color.set(fallback);
    } catch (e) {
      color.set(fallback);
    }
    return color;
  }

  let matKey = '';
  function drawMat(force) {
    const sig = matBase.getHexString() + inkColor.getHexString() + (theme.isDark ? 'd' : 'l');
    if (!force && sig === matKey) return;
    matKey = sig;
    const g = matCanvas.getContext('2d');
    const W = matCanvas.width, H = matCanvas.height;
    const s = W / (MAT.x1 - MAT.x0);
    const dark = !!theme.isDark;
    const base = '#' + matBase.getHexString();
    const ink = '#' + inkColor.getHexString();
    g.save();
    g.globalAlpha = 1;
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = ink;
    const col = (x) => (x - MAT.x0) * s;
    const row = (z) => (z - MAT.z0) * s;
    const lines = (major) => {
      g.beginPath();
      for (let x = Math.ceil(MAT.x0); x <= MAT.x1; x++) {
        if ((x % 5 === 0) !== major) continue;
        const px = Math.round(col(x)) + 0.5;
        g.moveTo(px, 0); g.lineTo(px, H);
      }
      for (let z = Math.ceil(MAT.z0); z <= MAT.z1; z++) {
        if ((z % 5 === 0) !== major) continue;
        const py = Math.round(row(z)) + 0.5;
        g.moveTo(0, py); g.lineTo(W, py);
      }
      g.stroke();
    };
    g.globalAlpha = dark ? 0.15 : 0.1;
    g.lineWidth = Math.max(1, s * 0.035);
    lines(false);
    g.globalAlpha = dark ? 0.32 : 0.22;
    g.lineWidth = Math.max(1.5, s * 0.075);
    lines(true);
    // cm numerals along the far edge, measured from the mat's left edge
    const fs = Math.round(s * 0.62);
    g.font = `500 ${fs}px "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const ty = row(MAT.z0 + 1.05);
    for (let x = MAT.x0 + 5; x < MAT.x1; x += 5) {
      const label = String(x - MAT.x0);
      const px = col(x);
      const tw = g.measureText(label).width;
      g.globalAlpha = 1;
      g.fillStyle = base;
      g.fillRect(px - tw / 2 - s * 0.12, ty - fs * 0.62, tw + s * 0.24, fs * 1.24);
      g.globalAlpha = dark ? 0.72 : 0.62;
      g.fillStyle = ink;
      g.fillText(label, px, ty);
    }
    g.globalAlpha = dark ? 0.6 : 0.5;
    g.font = `500 ${Math.round(fs * 0.8)}px "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace`;
    g.textAlign = 'left';
    g.fillText('cm', col(MAT.x0 + 0.6), ty);
    g.restore();
    matTex.needsUpdate = true;
  }

  function setTheme(t) {
    theme = { ...theme, ...(t || {}) };
    const dark = !!theme.isDark;
    lighting = dark ? LIGHTING.dark : LIGHTING.light;
    parseInto(bgColor, theme.bg, dark ? '#1A1F25' : DEFAULT_THEME.bg);
    scene.fog.color.copy(bgColor);
    parseInto(matBase, theme.floor, dark ? '#3A424B' : DEFAULT_THEME.floor);
    // Dark theme: lift the mat toward a light slate so light transmitted through the gel isn't black.
    if (lighting.matLift > 0) matBase.lerp(_c1.set(0xb9c3cd), lighting.matLift);
    parseInto(inkColor, theme.ink, dark ? '#E7EBEE' : DEFAULT_THEME.ink);
    floorMat.color.copy(matBase).lerp(bgColor, dark ? 0.72 : 0.4);
    matSideMat.color.copy(matBase).multiplyScalar(0.78);
    hemi.groundColor.copy(matBase);
    parseInto(wireMat.color, theme.accent, DEFAULT_THEME.accent);
    markerMat.color.copy(wireMat.color);
    threadMat.color.copy(wireMat.color);
    flashMat.color.copy(wireMat.color).lerp(_white, 0.45);
    key.intensity = lighting.key;
    key.shadow.intensity = lighting.shadow;
    hemi.intensity = lighting.hemi;
    jellyMat.envMapIntensity = lighting.envJelly;
    bubbleMat.envMapIntensity = lighting.envJelly;
    matTopMat.envMapIntensity = matSideMat.envMapIntensity = floorMat.envMapIntensity = lighting.envSet;
    drawMat();
  }

  // Redraw the mat numerals once web fonts are ready (they may have fallen back on first draw).
  try {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!disposed) drawMat(true); });
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- material controls
  let faceTex = null;
  function setFaceTexture(src) {
    if (!src) return;
    if (faceTex && faceTex.image === src) {
      faceTex.needsUpdate = true;
      return;
    }
    const tex = new THREE.CanvasTexture(src);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const old = faceTex;
    faceTex = tex;
    jellyMat.map = tex;
    if (!old) jellyMat.needsUpdate = true;
    else old.dispose();
  }

  let flavorKey = 'clear';
  function setFlavor(k) {
    const f = FLAVORS[k] || FLAVORS.clear;
    flavorKey = FLAVORS[k] ? k : 'clear';
    jellyMat.color.set(f.color);
    jellyMat.attenuationColor.set(f.atten);
    jellyMat.attenuationDistance = f.dist;
  }

  let clarity = 0.55;
  function setClarity(v) {
    clarity = clamp(Number.isFinite(+v) ? +v : clarity, 0, 1);
    jellyMat.transmission = 0.25 + 0.65 * clarity;              // cloudy 0.25 .. glassy 0.9
    jellyMat.roughness = 0.15 - 0.09 * clarity;                 // cloudy blurs the refraction a little more
  }

  let showMesh = false;
  function setShowMesh(on) {
    showMesh = !!on;
    wiresGroup.visible = showMesh;
    if (showMesh) {
      for (const rec of records) {
        ensureWire(rec);
        rec.wireDirty = true;
      }
    }
  }

  // ---------------------------------------------------------------- per-body records
  let records = [];
  const meshList = [];
  let syncedWorld = null;
  let syncedVersion = NaN;

  function createRecord(body) {
    const geo = body.geo;
    const s = geo && geo.surface;
    if (!s || !s.index || !s.uvs) return null;
    const vcount = s.uvs.length / 2;
    const pos = new Float32Array(vcount * 3);
    const nrm = new Float32Array(vcount * 3);
    const index = asIndex(s.index);
    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const nrmAttr = new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('normal', nrmAttr);
    geometry.setAttribute('uv', new THREE.BufferAttribute(asF32(s.uvs), 2));
    const print = s.print && s.print.length === vcount ? asF32(s.print) : new Float32Array(vcount).fill(1);
    geometry.setAttribute('facePrint', new THREE.BufferAttribute(print, 1));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.Mesh(geometry, jellyMat);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;       // vertices move every frame; bounds are refreshed on pick instead
    mesh.matrixAutoUpdate = false;
    mesh.userData.body = body;
    const b = geo.bubbles;
    const nb = b && b.r ? b.r.length : 0;
    return {
      body, geo, mesh, geometry, pos, nrm, index, posAttr, nrmAttr,
      nb, bubbleR: nb ? b.r : null,
      stamp: NaN, dirty: true, boundsDirty: true,
      wire: null, wirePos: null, wireAttr: null, wireDirty: true,
    };
  }

  function ensureWire(rec) {
    if (rec.wire) return;
    const x = rec.body.x;
    const edges = rec.geo.edges;
    if (!x || !edges || !edges.length) return;
    const g = new THREE.BufferGeometry();
    rec.wirePos = new Float32Array(x.length);
    rec.wireAttr = new THREE.BufferAttribute(rec.wirePos, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', rec.wireAttr);
    g.setIndex(new THREE.BufferAttribute(asIndex(edges), 1));
    rec.wire = new THREE.LineSegments(g, wireMat);
    rec.wire.frustumCulled = false;
    rec.wire.matrixAutoUpdate = false;
    rec.wire.renderOrder = 10;
    wiresGroup.add(rec.wire);
  }

  function disposeRecord(rec) {
    bodiesGroup.remove(rec.mesh);
    rec.geometry.dispose();
    if (rec.wire) {
      wiresGroup.remove(rec.wire);
      rec.wire.geometry.dispose();
      rec.wire = null;
    }
  }

  function needsRebuild(world) {
    if (world !== syncedWorld || world.version !== syncedVersion) return true;
    const bodies = world.bodies || [];
    if (bodies.length !== records.length) return true;
    for (let i = 0; i < bodies.length; i++) {
      const rec = records[i];
      if (rec.body !== bodies[i] || rec.geo !== bodies[i].geo) return true;
    }
    return false;
  }

  function rebuild(world) {
    const bodies = world.bodies || [];
    const old = records;
    const next = [];
    for (const body of bodies) {
      let rec = null;
      for (let i = 0; i < old.length; i++) {
        const o = old[i];
        if (o && o.body === body && o.geo === body.geo) { rec = o; old[i] = null; break; }
      }
      if (!rec) {
        rec = createRecord(body);
        if (!rec) continue;
        bodiesGroup.add(rec.mesh);
      }
      rec.dirty = true;
      next.push(rec);
    }
    for (const o of old) if (o) disposeRecord(o);
    records = next;
    meshList.length = 0;
    let nb = 0;
    for (const rec of records) {
      meshList.push(rec.mesh);
      nb += rec.nb;
      if (showMesh) ensureWire(rec);
    }
    ensureBubbleCapacity(nb);
    syncedWorld = world;
    syncedVersion = world.version;
  }

  function sync(world) {
    if (!world) return;
    if (needsRebuild(world)) rebuild(world);
    let bi = 0;
    let bubblesChanged = false;
    const im = bubbles.instanceMatrix.array;
    for (let r = 0; r < records.length; r++) {
      const rec = records[r];
      const body = rec.body;
      const x = body.x;
      const st = x ? stamp(x) : NaN;
      const changed = rec.dirty || st !== rec.stamp;
      if (changed) {
        rec.stamp = st;
        rec.dirty = false;
        if (typeof body.updateSurface === 'function') body.updateSurface();
        const sp = body.surfacePositions;
        if (sp && sp.length === rec.pos.length) {
          rec.pos.set(sp);
          computeNormals(rec.pos, rec.index, rec.nrm);
          rec.posAttr.needsUpdate = true;
          rec.nrmAttr.needsUpdate = true;
          rec.boundsDirty = true;
        }
        rec.wireDirty = true;
        bubblesChanged = true;
      }
      if (showMesh && rec.wire && rec.wireDirty && x && x.length === rec.wirePos.length) {
        rec.wirePos.set(x);
        rec.wireAttr.needsUpdate = true;
        rec.wireDirty = false;
      }
      const bp = body.bubblePositions;
      if (rec.nb && bp && bp.length >= rec.nb * 3) {
        const rr = rec.bubbleR;
        for (let k = 0; k < rec.nb; k++, bi++) {
          const o = bi * 16, r0 = rr[k], p = k * 3;
          im[o] = r0; im[o + 1] = 0; im[o + 2] = 0; im[o + 3] = 0;
          im[o + 4] = 0; im[o + 5] = r0; im[o + 6] = 0; im[o + 7] = 0;
          im[o + 8] = 0; im[o + 9] = 0; im[o + 10] = r0; im[o + 11] = 0;
          im[o + 12] = bp[p]; im[o + 13] = bp[p + 1]; im[o + 14] = bp[p + 2]; im[o + 15] = 1;
        }
      }
    }
    if (bubbles.count !== bi) { bubbles.count = bi; bubblesChanged = true; }
    bubbles.visible = bi > 0;
    if (bubblesChanged && bi > 0) bubbles.instanceMatrix.needsUpdate = true;

    // optional grab visual
    const grab = world.grab;
    const anchor = grab && grab.anchor;
    if (anchor && Number.isFinite(anchor[0]) && Number.isFinite(anchor[1]) && Number.isFinite(anchor[2])) {
      marker.position.set(anchor[0], anchor[1], anchor[2]);
      marker.visible = true;
      const pt = grab.point;
      if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Number.isFinite(pt[2])) {
        threadPos[0] = pt[0]; threadPos[1] = pt[1]; threadPos[2] = pt[2];
        threadPos[3] = anchor[0]; threadPos[4] = anchor[1]; threadPos[5] = anchor[2];
        threadGeo.attributes.position.needsUpdate = true;
        thread.visible = true;
      } else thread.visible = false;
    } else {
      marker.visible = false;
      thread.visible = false;
    }
  }

  // ---------------------------------------------------------------- render / resize
  let cssW = 0, cssH = 0;
  let disposed = false;

  function render() {
    if (disposed || cssW < 1 || cssH < 1) return;
    if (flash.visible) {
      const t = (performance.now() - flashStart) / FLASH_MS;
      if (t >= 1) { flash.visible = false; flashMat.opacity = 0; }
      else flashMat.opacity = 0.95 * (1 - t) * (1 - t);
    }
    renderer.render(scene, camera);
  }

  function resize(w, h, dpr) {
    w = Math.max(1, Math.floor(+w || 0));
    h = Math.max(1, Math.floor(+h || 0));
    cssW = w; cssH = h;
    const ratio = clamp(+dpr || (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 0.5, 2);
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fitBaseDistance();
    updateCamera();
  }

  // ---------------------------------------------------------------- picking & geometry queries
  function pick(nx, ny) {
    if (!records.length) return null;
    _ndc.set(+nx || 0, +ny || 0);
    raycaster.setFromCamera(_ndc, camera);
    for (const rec of records) {
      if (rec.boundsDirty) {
        rec.geometry.computeBoundingSphere();
        rec.boundsDirty = false;
      }
    }
    hits.length = 0;
    raycaster.intersectObjects(meshList, false, hits);
    if (!hits.length) return null;
    const h = hits[0];
    const n = h.normal && h.normal.lengthSq() > 1e-12 ? h.normal : h.face.normal;
    _v.copy(n).normalize();
    if (_v.dot(raycaster.ray.direction) > 0) _v.negate();
    const out = {
      body: h.object.userData.body,
      point: [h.point.x, h.point.y, h.point.z],
      normal: [_v.x, _v.y, _v.z],
    };
    hits.length = 0;
    return out;
  }

  function ray(nx, ny) {
    _ndc.set(+nx || 0, +ny || 0);
    raycaster.setFromCamera(_ndc, camera);
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
  }

  function viewDir() {
    camera.getWorldDirection(_v);
    return [_v.x, _v.y, _v.z];
  }

  function project(p) {
    _v.set(+p[0], +p[1], +p[2]).project(camera);
    return [_v.x, _v.y];
  }

  // Plane through the eye and the two NDC rays. accept() re-projects a world point with the camera as it
  // was when the stroke ended and checks that it falls between A and B along the stroke.
  function makeBlade(ndcA, ndcB) {
    ndcXY(ndcA, _a);
    ndcXY(ndcB, _b);
    const eye = camera.position;
    _v.set(_a.x, _a.y, 0.5).unproject(camera).sub(eye).normalize();
    _v2.set(_b.x, _b.y, 0.5).unproject(camera).sub(eye).normalize();
    const n = new THREE.Vector3().crossVectors(_v, _v2);
    let valid = true;
    if (n.lengthSq() < 1e-14) {
      // A == B: fall back to a vertical plane through the ray; accept() rejects everything anyway.
      n.crossVectors(_v, camera.up);
      if (n.lengthSq() < 1e-14) n.set(1, 0, 0);
      valid = false;
    }
    n.normalize();
    const d = n.dot(eye);
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = m.elements;
    const asp = camera.aspect;
    const ax = _a.x * asp, ay = _a.y;
    const abx = _b.x * asp - ax, aby = _b.y - ay;
    const len2 = abx * abx + aby * aby;
    const accept = (x, y, z) => {
      if (!valid || len2 < 1e-12) return false;
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (!(cw > 1e-6)) return false;                      // behind the eye
      const px = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw) * asp;
      const py = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
      const t = ((px - ax) * abx + (py - ay) * aby) / len2;
      return t >= -1e-6 && t <= 1 + 1e-6;
    };
    return { n: [n.x, n.y, n.z], d, accept, eye: [eye.x, eye.y, eye.z], valid };
  }

  function bladePlane(ndcA, ndcB) {
    const b = makeBlade(ndcA, ndcB);
    return { n: b.n, d: b.d, accept: b.accept };
  }

  function flashCut(ndcA, ndcB) {
    const blade = makeBlade(ndcA, ndcB);
    if (!blade.valid) return;
    const [nx, ny, nz] = blade.n, d = blade.d;
    const [ex, ey, ez] = blade.eye;
    let seg = 0;
    // Intersect the plane with the surfaces as currently drawn (the pre-cut shape when called right after
    // world.slice), keeping only camera-facing triangles inside the stroke span.
    for (const rec of records) {
      const pos = rec.pos, idx = rec.index;
      for (let t = 0, tl = idx.length; t < tl && seg < FLASH_MAX_SEG; t += 3) {
        const ia = idx[t] * 3, ib = idx[t + 1] * 3, ic = idx[t + 2] * 3;
        const da = nx * pos[ia] + ny * pos[ia + 1] + nz * pos[ia + 2] - d;
        const db = nx * pos[ib] + ny * pos[ib + 1] + nz * pos[ib + 2] - d;
        const dc = nx * pos[ic] + ny * pos[ic + 1] + nz * pos[ic + 2] - d;
        if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
        // facing test
        const e1x = pos[ib] - pos[ia], e1y = pos[ib + 1] - pos[ia + 1], e1z = pos[ib + 2] - pos[ia + 2];
        const e2x = pos[ic] - pos[ia], e2y = pos[ic + 1] - pos[ia + 1], e2z = pos[ic + 2] - pos[ia + 2];
        const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
        if (fx * (ex - pos[ia]) + fy * (ey - pos[ia + 1]) + fz * (ez - pos[ia + 2]) <= 0) continue;
        let k = 0;
        let p0x = 0, p0y = 0, p0z = 0, p1x = 0, p1y = 0, p1z = 0;
        const edge = (i0, d0, i1, d1) => {
          if ((d0 > 0) === (d1 > 0) || d0 === d1) return;
          const s = d0 / (d0 - d1);
          const x = pos[i0] + (pos[i1] - pos[i0]) * s;
          const y = pos[i0 + 1] + (pos[i1 + 1] - pos[i0 + 1]) * s;
          const z = pos[i0 + 2] + (pos[i1 + 2] - pos[i0 + 2]) * s;
          if (k === 0) { p0x = x; p0y = y; p0z = z; } else { p1x = x; p1y = y; p1z = z; }
          k++;
        };
        edge(ia, da, ib, db);
        edge(ib, db, ic, dc);
        if (k < 2) edge(ic, dc, ia, da);
        if (k < 2) continue;
        if (!blade.accept((p0x + p1x) / 2, (p0y + p1y) / 2, (p0z + p1z) / 2)) continue;
        // ribbon across the plane (plane normal is perpendicular to both the segment and the eye ray)
        const w = FLASH_HALF_WIDTH * Math.max(1, Math.hypot(p0x - ex, p0y - ey, p0z - ez) / 30);
        const wx = nx * w, wy = ny * w, wz = nz * w;
        const o = seg * 12;
        flashPos[o] = p0x - wx; flashPos[o + 1] = p0y - wy; flashPos[o + 2] = p0z - wz;
        flashPos[o + 3] = p0x + wx; flashPos[o + 4] = p0y + wy; flashPos[o + 5] = p0z + wz;
        flashPos[o + 6] = p1x + wx; flashPos[o + 7] = p1y + wy; flashPos[o + 8] = p1z + wz;
        flashPos[o + 9] = p1x - wx; flashPos[o + 10] = p1y - wy; flashPos[o + 11] = p1z - wz;
        seg++;
      }
    }
    if (!seg) return;
    flashPosAttr.needsUpdate = true;
    flashPosAttr.clearUpdateRanges();
    flashPosAttr.addUpdateRange(0, seg * 12);
    flashGeo.setDrawRange(0, seg * 6);
    flashStart = performance.now();
    flashMat.opacity = 0.95;
    flash.visible = true;
  }

  // ---------------------------------------------------------------- view controls
  function orbit(dAz, dEl) {
    az += +dAz || 0;
    if (az > Math.PI) az -= 2 * Math.PI * Math.ceil((az - Math.PI) / (2 * Math.PI));
    if (az < -Math.PI) az += 2 * Math.PI * Math.ceil((-Math.PI - az) / (2 * Math.PI));
    el = clamp(el + (+dEl || 0), VIEW.minEl, VIEW.maxEl);
    updateCamera();
  }

  function zoom(factor) {
    const f = +factor;
    if (!(f > 0) || !Number.isFinite(f)) return;
    zoomScale = clamp(zoomScale / f, VIEW.minZoom, VIEW.maxZoom);
    updateCamera();
  }

  function resetView() {
    az = 0;
    el = VIEW.elevation;
    zoomScale = 1;
    updateCamera();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const rec of records) disposeRecord(rec);
    records = [];
    meshList.length = 0;
    if (bubbles) bubbles.dispose();
    bubbleGeo.dispose(); bubbleMat.dispose();
    jellyMat.dispose(); wireMat.dispose();
    if (faceTex) faceTex.dispose();
    matTex.dispose(); matTopMat.dispose(); matSideMat.dispose(); matMesh.geometry.dispose();
    floorGeo.dispose(); floorMat.dispose();
    marker.geometry.dispose(); markerMat.dispose();
    threadGeo.dispose(); threadMat.dispose();
    flashGeo.dispose(); flashMat.dispose();
    envRT.dispose();
    renderer.dispose();
  }

  // ---------------------------------------------------------------- init
  setTheme(DEFAULT_THEME);
  setFlavor('clear');
  setClarity(0.55);
  resize(canvas.clientWidth || canvas.width || 300, canvas.clientHeight || canvas.height || 150,
    typeof window !== 'undefined' ? window.devicePixelRatio : 1);

  return {
    setTheme, setFaceTexture, setFlavor, setClarity, setShowMesh,
    sync, render, resize,
    pick, ray, viewDir, project, bladePlane,
    orbit, zoom, resetView, flashCut, dispose,
    // debugging / tests only (not part of the SPEC contract)
    get flavor() { return flavorKey; },
    get clarity() { return clarity; },
    get showMesh() { return showMesh; },
    get view() { return { azimuth: az, elevation: el, distance: baseDist * zoomScale, baseDistance: baseDist }; },
    three: { THREE, renderer, scene, camera, jellyMat, LIGHTING, FLAVORS },
  };
}

// Rounded-rectangle slab: top face at y = 0 with UVs spanning the mat texture, sides in group 1.
function buildMatGeometry() {
  const { x0, x1, z0, z1, radius: r, thick } = MAT;
  // Shape lives in (x, y) with y = -z so that rotateX(-90deg) lays it on the floor.
  const sx0 = x0, sx1 = x1, sy0 = -z1, sy1 = -z0;
  const shape = new THREE.Shape();
  shape.moveTo(sx0 + r, sy0);
  shape.lineTo(sx1 - r, sy0);
  shape.quadraticCurveTo(sx1, sy0, sx1, sy0 + r);
  shape.lineTo(sx1, sy1 - r);
  shape.quadraticCurveTo(sx1, sy1, sx1 - r, sy1);
  shape.lineTo(sx0 + r, sy1);
  shape.quadraticCurveTo(sx0, sy1, sx0, sy1 - r);
  shape.lineTo(sx0, sy0 + r);
  shape.quadraticCurveTo(sx0, sy0, sx0 + r, sy0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 8 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -thick, 0);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, (p.getX(i) - x0) / (x1 - x0), (z1 - p.getZ(i)) / (z1 - z0));
  }
  uv.needsUpdate = true;
  return geo;
}
