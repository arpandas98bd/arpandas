// app.js — Root Viewer web app: UI, three.js 3D scene, picking, comparison, export.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as E from './engine.js';

const $ = id => document.getElementById(id);
const COL = { root: 0xd9b48a, main: 0xf2b45a, lateral: 0x5fd0c0, fragment: 0xc98bd6, minor: 0x777777, water: 0x4fa3ff,
  marker: 0x9c9286, noise: 0xe05a5a, excluded: 0xff4fb0, sel: 0xff00ff, tip: 0xffe14d, branch: 0xff7043 };
const RUN_COLORS = ['#ff6b6b', '#4dabf7', '#69db7c', '#ffd43b', '#da77f2', '#ffa94d', '#38d9a9', '#f783ac'];
const KEY_TRAITS = [['n_main_roots', 'Main'], ['n_lateral_roots', 'Lat.'], ['total_root_length_mm', 'Length mm'], ['rooting_depth_mm', 'Depth mm'], ['n_root_tips', 'Tips'], ['n_water_blobs', 'Blobs']];

// ------------------------------------------------------------------ state
const S = {
  fileName: '', shape: null, voxel: [2, 2, 2], tex: null, winLo: 0.3, winHi: 0.9,
  result: null, entries: [], runs: [], selection: null, tool: 'select', busy: false, spin: false,
};

// ------------------------------------------------------------------ worker
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data; dirty();
  if (m.type === 'progress') busy(m.msg);
  else if (m.type === 'error') { busy(false); status('⚠ ' + m.msg, true); alertBox(m.msg); S.runCount = (S.runCount || 0) + 1; }
  else if (m.type === 'vars') onVars(m.vars);
  else if (m.type === 'volume') onVolume(m);
  else if (m.type === 'result') onResult(m.result);
};

// ------------------------------------------------------------------ params form
const PARAMS = [
  ['lo', 'Low threshold (SD)', 0.5, 50, 0.5, 'Voxels above this many noise SDs can join a root (growing threshold). Lower = fainter roots, more noise.'],
  ['hi', 'High threshold (SD)', 0.5, 100, 0.5, 'A root must contain voxels above this many noise SDs (seed threshold).'],
  ['sigma', 'Smoothing σ', 0, 3, 0.1, 'Noise smoothing before detection (voxels).'],
  ['n_markers', 'Markers to drop', 0, 10, 1, 'Bright detached blobs treated as reference markers. Set 0 if your scan has none.'],
  ['min_frag', 'Min detached piece', 1, 5000, 1, 'Smallest detached piece kept as root (voxels).'],
  ['frag_dist', 'Max gap to roots', 0, 50, 1, 'Largest gap (voxels) between a detached piece and the root system for it to count as root.'],
  ['water_filter', 'Water-blob filter', null, null, null, 'Remove round water pockets / swellings using a tube-vs-blob shape analysis.'],
  ['blob_ratio', 'Blob strictness', 0.2, 5, 0.1, 'Higher = only very round regions are treated as water.'],
  ['min_blob', 'Min blob size', 1, 5000, 1, 'Smallest blob core (voxels).'],
  ['crown_protect', 'Protect base radius', 0, 100, 1, 'Blobs this close to the plant base (seed/crown) are left alone.'],
  ['crown', 'Main-root radius', 1, 200, 1, 'Roots starting within this radius (voxels) of the base are main (seminal/crown) roots.'],
  ['min_main', 'Min main length', 1, 500, 1, 'Shortest main root (voxels).'],
  ['min_lat', 'Min lateral length', 1, 500, 1, 'Shortest lateral root (voxels).'],
];
function buildParamForm() {
  const f = $('paramForm'); f.innerHTML = '';
  for (const [k, lab, mn, mx, st, tip] of PARAMS) {
    const row = document.createElement('div'); row.className = 'row'; row.title = tip;
    if (mn === null) row.innerHTML = `<label><input type="checkbox" id="p_${k}" ${E.DEFAULTS[k] ? 'checked' : ''}> ${lab}</label>`;
    else row.innerHTML = `<label for="p_${k}">${lab}</label><input type="number" id="p_${k}" min="${mn}" max="${mx}" step="${st}" value="${E.DEFAULTS[k]}">`;
    f.appendChild(row);
  }
}
function getParams() {
  const p = { voxel: [0, 1, 2].map(a => +$('vx' + a).value || 1) };
  for (const [k, , mn] of PARAMS) p[k] = mn === null ? $('p_' + k).checked : +$('p_' + k).value;
  return p;
}
function setParams(p) { for (const [k, , mn] of PARAMS) { if (mn === null) $('p_' + k).checked = !!p[k]; else $('p_' + k).value = p[k]; } }

// ------------------------------------------------------------------ UI helpers
function status(msg, err = false) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); }
function busy(msg) {
  S.busy = !!msg; $('busy').hidden = !msg; if (msg) $('busyMsg').textContent = msg;
  for (const id of ['btnRun', 'btnReload', 'btnRoot', 'btnNonroot', 'btnUndo', 'btnClear', 'btnExport']) $(id).disabled = !!msg;
}
function alertBox(msg) { $('selInfo').textContent = '⚠ ' + msg; }
const fmt = (v, d = 1) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })) : String(v));

// ------------------------------------------------------------------ three.js scene
const canvas = $('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = 0.12;
scene.add(new THREE.HemisphereLight(0xfff3e0, 0x302418, 1.4));
const headLight = new THREE.DirectionalLight(0xffffff, 1.6); camera.add(headLight); headLight.position.set(0.3, 0.5, 1); scene.add(camera);

const L = {}; // layers: {name: {obj, label, color, opacity, visible}}
const LAYER_DEFS = [
  ['mri', 'MRI image (original)', '#bbbbbb', 0.85, true],
  ['root', 'Root surface', '#d9b48a', 0.4, true],
  ['skel', 'Skeleton (main / lateral)', '#f2b45a', 1, true],
  ['tips', 'Root tips', '#ffe14d', 1, true],
  ['branch', 'Branch points', '#ff7043', 1, false],
  ['water', 'Water blobs (removed)', '#4fa3ff', 0.45, true],
  ['markers', 'Markers', '#9c9286', 0.8, true],
  ['excluded', 'Excluded by you', '#ff4fb0', 0.8, true],
  ['noise', 'Detached noise', '#e05a5a', 0.8, false],
  ['sel', 'Selection', '#ff00ff', 0.8, true],
];
for (const [k, label, color, opacity, visible] of LAYER_DEFS) L[k] = { obj: null, label, color, opacity, visible };

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); dirty();
}
new ResizeObserver(resize).observe(canvas.parentElement);

let volMat = null;
let needsRender = true; const dirty = () => { needsRender = true; };
// draw only when something changed (camera, layers, settings) — saves GPU and battery
['pointerdown', 'pointermove', 'wheel', 'input', 'change', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, dirty, { passive: true }));
function render() {
  requestAnimationFrame(render);
  controls.autoRotate = !!(S.spin && S.shape); controls.autoRotateSpeed = 2.2;
  const moved = controls.update();
  if (!(moved || needsRender || controls.autoRotate)) return;
  needsRender = false;
  if (volMat) volMat.uniforms.uCam.value.copy(camera.position);
  renderer.render(scene, camera);
}
render();

// world <-> voxel. voxel centre (i,j,k) -> x=(i+.5-I/2)v0, y=(k+.5-K/2)v2, z=-(j+.5-J/2)v1
function w(i, j, k) { const [I, J, K] = S.shape, v = S.voxel; return new THREE.Vector3((i + 0.5 - I / 2) * v[0], (k + 0.5 - K / 2) * v[2], -(j + 0.5 - J / 2) * v[1]); }
function boxSize() { const [I, J, K] = S.shape, v = S.voxel; return new THREE.Vector3(I * v[0], K * v[2], J * v[1]); }

function disposeObj(o) { if (!o) return; scene.remove(o); o.traverse(c => { c.geometry?.dispose(); if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose()); }); }
function setLayer(k, obj) {
  disposeObj(L[k].obj); L[k].obj = obj; dirty();
  if (obj) { scene.add(obj); obj.visible = L[k].visible; applyOpacity(k); }
}
function applyOpacity(k) {
  const o = L[k].obj; if (!o) return;
  if (k === 'mri') { volMat.uniforms.uOpacity.value = L[k].opacity; return; }
  o.traverse(c => { if (c.material) { c.material.opacity = L[k].opacity; c.material.transparent = L[k].opacity < 1 || k === 'sel'; c.material.depthWrite = L[k].opacity >= 0.99 && k !== 'sel'; } });
}

// ---- MRI volume (maximum intensity projection ray-marching)
const VS = `out vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS = `precision highp float; precision highp sampler3D;
uniform sampler3D uVol; uniform vec3 uSize; uniform vec3 uCam; uniform float uLo, uHi, uGamma, uOpacity;
in vec3 vPos; out vec4 outColor;
void main(){
  vec3 o = uCam; vec3 d = normalize(vPos - o);
  vec3 bmin = -0.5*uSize, bmax = 0.5*uSize; vec3 inv = 1.0/d;
  vec3 t0 = (bmin-o)*inv, t1 = (bmax-o)*inv; vec3 tn = min(t0,t1), tf = max(t0,t1);
  float a = max(max(max(tn.x,tn.y),tn.z), 0.0), b = min(min(tf.x,tf.y),tf.z);
  if (a >= b) discard;
  float mx = 0.0; const int N = 320; float dt = (b-a)/float(N);
  for (int s = 0; s < N; s++) {
    vec3 p = o + d*(a + (float(s)+0.5)*dt); vec3 u = p/uSize + 0.5;
    mx = max(mx, texture(uVol, vec3(u.y, 1.0-u.z, u.x)).r);
  }
  float c = clamp((mx-uLo)/max(uHi-uLo,1e-4), 0.0, 1.0); c = pow(c, uGamma);
  outColor = vec4(vec3(c), c*uOpacity);
}`;
function buildVolume() {
  const [I, J, K] = S.shape;
  const tex = new THREE.Data3DTexture(S.tex, K, J, I);
  tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
  const sz = boxSize();
  volMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, side: THREE.BackSide,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uVol: { value: tex }, uSize: { value: sz }, uCam: { value: new THREE.Vector3() }, uLo: { value: S.winLo }, uHi: { value: S.winHi }, uGamma: { value: 0.8 }, uOpacity: { value: L.mri.opacity } } });
  const m = new THREE.Mesh(new THREE.BoxGeometry(sz.x, sz.y, sz.z), volMat); m.renderOrder = -1;
  setLayer('mri', m);
}

// ---- meshes
function meshFromSurface(ms, color, byHeight = false) {
  if (!ms || !ms.pos.length) return null;
  const n = ms.pos.length / 3; const pos = new Float32Array(ms.pos.length); const col = byHeight ? new Float32Array(ms.pos.length) : null;
  const [I, J, K] = S.shape, v = S.voxel;
  const c0 = new THREE.Color(0x6b4a2b), c1 = new THREE.Color(0xc79b6b), c2 = new THREE.Color(0xf3e3c7), tmp = new THREE.Color();
  for (let t = 0; t < n; t++) {
    const i = ms.pos[3 * t], j = ms.pos[3 * t + 1], k = ms.pos[3 * t + 2];
    pos[3 * t] = (i + 0.5 - I / 2) * v[0]; pos[3 * t + 1] = (k + 0.5 - K / 2) * v[2]; pos[3 * t + 2] = -(j + 0.5 - J / 2) * v[1];
    if (col) { const h = k / K; tmp.copy(h < 0.5 ? c0 : c1).lerp(h < 0.5 ? c1 : c2, h < 0.5 ? h * 2 : (h - 0.5) * 2); col.set([tmp.r, tmp.g, tmp.b], 3 * t); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(ms.idx, 1)); g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: byHeight ? 0xffffff : color, vertexColors: byHeight, roughness: 0.65, metalness: 0.0, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat); mesh.renderOrder = 1; return mesh;
}
function tubes(axes, colorFn, radius) {
  const byColor = new Map();
  for (const a of axes) {
    if (a.type === 'minor' || a.pts.length < 2) continue;
    const pts = a.pts.filter((_, t) => t % 2 === 0 || t === a.pts.length - 1).map(q => w(q[0], q[1], q[2]));
    if (pts.length < 2) pts.push(w(...a.pts[a.pts.length - 1]));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const g = new THREE.TubeGeometry(curve, Math.max(4, pts.length * 3), radius, 6, false);
    const c = colorFn(a); if (!byColor.has(c)) byColor.set(c, []); byColor.get(c).push(g);
  }
  const grp = new THREE.Group();
  for (const [c, gs] of byColor) {
    const merged = mergeGeometries(gs); gs.forEach(g => g.dispose());
    const m = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, emissive: c, emissiveIntensity: 0.18 })); m.renderOrder = 2; grp.add(m);
  }
  return grp;
}
function spheres(list, color, r) {
  if (!list.length) return null;
  const im = new THREE.InstancedMesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 }), list.length);
  const mtx = new THREE.Matrix4(); list.forEach((q, t) => { mtx.makeTranslation(w(q[0], q[1], q[2])); im.setMatrixAt(t, mtx); });
  im.renderOrder = 3; return im;
}
function cubes(indices, color) {
  if (!indices.length) return null;
  const [I, J, K] = S.shape, v = S.voxel;
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(v[0], v[2], v[1]), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, transparent: true }), indices.length);
  const mtx = new THREE.Matrix4();
  indices.forEach((idx, t) => { const k = idx % K, j = Math.floor(idx / K) % J, i = Math.floor(idx / (J * K)); mtx.makeTranslation(w(i, j, k)); im.setMatrixAt(t, mtx); });
  im.renderOrder = 4; return im;
}

function buildResultLayers() {
  const r = S.result; const vmin = Math.min(...S.voxel);
  setLayer('root', meshFromSurface(r.meshes.root, COL.root, true));
  setLayer('water', meshFromSurface(r.meshes.water, COL.water));
  setLayer('markers', meshFromSurface(r.meshes.markers, COL.marker));
  setLayer('excluded', meshFromSurface(r.meshes.excluded, COL.excluded));
  setLayer('noise', cubes(Array.from(r.noise), COL.noise));
  setLayer('skel', tubes(r.axes, a => COL[a.type] ?? COL.minor, 0.45 * vmin));
  setLayer('tips', spheres(r.tips, COL.tip, 0.9 * vmin));
  setLayer('branch', spheres(r.branchPts, COL.branch, 0.75 * vmin));
  setLayer('sel', null); S.selection = null; $('selInfo').textContent = 'Nothing selected';
}

// ---- layer panel
function buildLayerPanel() {
  const box = $('layerList'); box.innerHTML = '';
  for (const [k] of LAYER_DEFS) {
    const l = L[k];
    const row = document.createElement('div'); row.className = 'lyr';
    row.innerHTML = `<input type="checkbox" ${l.visible ? 'checked' : ''}><span><i class="sw" style="background:${l.color}"></i>${l.label}</span><input type="range" min="0.05" max="1" step="0.05" value="${l.opacity}">`;
    const [cb, , rg] = row.children;
    cb.onchange = () => { l.visible = cb.checked; if (l.obj) l.obj.visible = l.visible; };
    rg.oninput = () => { l.opacity = +rg.value; applyOpacity(k); };
    box.appendChild(row);
    if (k === 'mri') {
      for (const [lab, key, mn, mx, st] of [['contrast low', 'uLo', 0, 1, 0.005], ['contrast high', 'uHi', 0, 1, 0.005], ['gamma', 'uGamma', 0.2, 3, 0.05]]) {
        const sub = document.createElement('div'); sub.className = 'lyr sub';
        sub.innerHTML = `<span></span><span>${lab}</span><input type="range" min="${mn}" max="${mx}" step="${st}" data-k="${key}">`;
        const inp = sub.children[2];
        inp.value = key === 'uLo' ? S.winLo : key === 'uHi' ? S.winHi : 0.8;
        inp.oninput = () => { if (volMat) volMat.uniforms[key].value = +inp.value; };
        box.appendChild(sub);
      }
    }
  }
  // saved runs
  S.runs.forEach((run) => {
    const row = document.createElement('div'); row.className = 'lyr';
    row.innerHTML = `<input type="checkbox" ${run.visible ? 'checked' : ''}><span><i class="sw" style="background:${run.color}"></i>Saved: ${run.name}</span><span></span>`;
    row.children[0].onchange = (e) => { run.visible = e.target.checked; run.obj.visible = run.visible; refreshRuns(); };
    box.appendChild(row);
  });
}
$('btnLayersToggle').onclick = () => { $('layers').classList.toggle('collapsed'); $('btnLayersToggle').textContent = $('layers').classList.contains('collapsed') ? '+' : '–'; };

// ---- camera views
function setView(name) {
  if (!S.shape) return;
  const sz = S.result ? rootsExtent() : boxSize(); const d = Math.max(sz.x, sz.y, sz.z) * 2.1;
  const dirs = { front: [0, 0.12, 1], angled: [0.6, 0.25, 0.8], side: [1, 0.12, 0], top: [0.001, 1, 0.001] };
  const v = new THREE.Vector3(...dirs[name]).normalize().multiplyScalar(d);
  // focus on roots if available
  const tgt = S.result ? centreOfRoots() : new THREE.Vector3();
  controls.target.copy(tgt); camera.position.copy(tgt).add(v); camera.up.set(0, 1, 0); controls.update(); dirty();
}
function rootsExtent() {
  const p = S.result.meshes.root.pos; if (!p.length) return boxSize();
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let t = 0; t < p.length; t += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[t + a]); mx[a] = Math.max(mx[a], p[t + a]); }
  const v = S.voxel; return new THREE.Vector3((mx[0] - mn[0]) * v[0], (mx[2] - mn[2]) * v[2], (mx[1] - mn[1]) * v[1]);
}
function centreOfRoots() {
  const r = S.result; if (!r.meshes.root.pos.length) return new THREE.Vector3();
  const p = r.meshes.root.pos; let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let t = 0; t < p.length; t += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[t + a]); mx[a] = Math.max(mx[a], p[t + a]); }
  return w((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2);
}
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => setView(b.dataset.view); });
$('btnSpin').onclick = () => { S.spin = !S.spin; $('btnSpin').classList.toggle('primary', S.spin); };

// ------------------------------------------------------------------ loading
async function loadFile(file) {
  S.fileName = file.name.replace(/\.mat$/i, ''); $('fileName').textContent = file.name;
  busy('Reading ' + file.name + '…');
  const buf = await file.arrayBuffer();
  worker.postMessage({ cmd: 'load', buffer: buf }, [buf]);
}
function onVars(vars) {
  const sel = $('selVar'); sel.innerHTML = '';
  for (const v of vars) { const o = document.createElement('option'); o.value = v.name; o.textContent = `${v.name}  [${v.dims.join('×')}]`; sel.appendChild(o); }
  const im = vars.find(v => v.name === 'im'); sel.value = im ? 'im' : vars.reduce((a, b) => (a.dims.reduce((x, y) => x * y) >= b.dims.reduce((x, y) => x * y) ? a : b)).name;
  openVolume();
}
function openVolume() {
  S.entries = []; refreshEdits();
  S.runs.forEach(r => disposeObj(r.obj)); S.runs = []; refreshRuns();
  busy('Preparing volume…');
  worker.postMessage({ cmd: 'open', varName: $('selVar').value, vertical: +$('selVert').value, baseHigh: $('chkBaseHigh').checked });
}
function onVolume(m) {
  S.shape = m.shape; S.tex = m.tex; S.winLo = m.winLo; S.winHi = m.winHi; S.voxel = [0, 1, 2].map(a => +$('vx' + a).value || 1);
  for (const k of ['root', 'water', 'markers', 'excluded', 'noise', 'skel', 'tips', 'branch', 'sel']) setLayer(k, null);
  buildVolume(); buildLayerPanel(); $('drop').classList.add('hidden');
  S.result = null; setView('angled'); runAnalysis();
}
$('fileInput').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
$('btnReload').onclick = () => { if ($('selVar').options.length) openVolume(); };
const view = $('view');
view.addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
view.addEventListener('dragleave', () => $('drop').classList.remove('over'));
view.addEventListener('drop', e => { e.preventDefault(); $('drop').classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
// optional example scan shipped with the site: examples/example.mat
fetch('examples/example.mat', { method: 'HEAD' }).then(r => { if (r.ok) $('btnExample').hidden = false; }).catch(() => {});
$('btnExample').onclick = async () => {
  busy('Downloading example scan…');
  const r = await fetch('examples/example.mat'); const b = await r.blob();
  loadFile(new File([b], 'example.mat'));
};

// ------------------------------------------------------------------ analysis
function currentEdits() {
  return { points: S.entries.filter(e => e.kind === 'point').map(e => [e.vox, e.action]),
    spheres: S.entries.filter(e => e.kind === 'sphere').map(e => ({ c: e.vox, r: e.r, mode: e.mode })) };
}
function runAnalysis() {
  if (!S.shape) return;
  const p = getParams();
  if (p.voxel.some((v, a) => v !== S.voxel[a])) { S.voxel = p.voxel; buildVolume(); }
  busy('Analysing…'); status('Analysing…');
  worker.postMessage({ cmd: 'analyze', params: p, edits: currentEdits() });
}
function onResult(r) {
  const first = !S.result; S.result = r; busy(false); S.runCount = (S.runCount || 0) + 1;
  buildResultLayers(); fillResults();
  if (first) setView('angled');
  const t = r.traits;
  status(`Done in ${r.seconds.toFixed(1)} s: ${t.n_main_roots} main, ${t.n_lateral_roots} laterals, ${(t.total_root_length_mm / 10).toFixed(1)} cm total, ${t.n_water_blobs} water blobs.`);
}
$('btnRun').onclick = runAnalysis;
$('btnDefaults').onclick = () => setParams(E.DEFAULTS);

// ------------------------------------------------------------------ results tables
const NICE = { total_root_length_mm: 'Total root length (mm)', n_main_roots: 'Main roots', n_lateral_roots: 'Lateral roots', n_fragments: 'Detached fragments',
  n_root_tips: 'Root tips', n_branch_points: 'Branch points', main_root_length_mm: 'Main root length (mm)', lateral_root_length_mm: 'Lateral root length (mm)',
  longest_root_mm: 'Longest root (mm)', rooting_depth_mm: 'Rooting depth (mm)', max_lateral_spread_mm: 'Max lateral spread (mm)', root_volume_mm3: 'Root volume (mm³)',
  mean_diameter_est_mm: 'Mean diameter, est. (mm)', n_water_blobs: 'Water blobs', water_volume_removed_mm3: 'Water volume removed (mm³)', water_stub_branches_removed: 'Fake branches into water removed' };
function fillResults() {
  const r = S.result; const t = r.traits;
  $('tblTraits').innerHTML = Object.entries(NICE).map(([k, lab]) => `<tr><td>${lab}</td><td>${fmt(t[k])}</td></tr>`).join('');
  $('tblRoots').innerHTML = '<tr><th>#</th><th>Type</th><th>Length mm</th><th>Tip depth mm</th><th>Parent</th></tr>' +
    r.roots.map(x => `<tr class="click" data-id="${x.root_id}"><td>${x.root_id}</td><td><span class="tagt ${x.type}">${x.type}</span></td><td class="n">${fmt(x.length_mm)}</td><td class="n">${fmt(x.tip_depth_mm)}</td><td class="n">${x.parent_id}</td></tr>`).join('');
  $('tblRoots').querySelectorAll('tr.click').forEach(tr => { tr.onclick = () => select({ kind: 'skeleton', id: +tr.dataset.id }); });
  depthChart(t.length_by_depth);
}
function depthChart(lb) {
  const W = 330, rowH = 13, H = lb.length_mm.length * rowH + 26; const mx = Math.max(...lb.length_mm, 1);
  let s = `<svg viewBox="0 0 ${W} ${H}" font-family="IBM Plex Sans" font-size="10" fill="#a39889">`;
  lb.length_mm.forEach((v, i) => {
    const y = i * rowH + 2, wd = (W - 110) * v / mx;
    s += `<text x="58" y="${y + 9}" text-anchor="end">${lb.bin_top_mm[i]}–${lb.bin_top_mm[i] + (lb.bin_top_mm[1] || 20)}</text><rect x="64" y="${y}" width="${wd.toFixed(1)}" height="${rowH - 3}" rx="2" fill="#c79b6b"/><text x="${68 + wd}" y="${y + 9}">${Math.round(v)}</text>`;
  });
  s += `<text x="64" y="${H - 4}">root length (mm) per depth band (mm below base)</text></svg>`;
  $('depthChart').innerHTML = s;
}

// ------------------------------------------------------------------ picking & selection
const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
function pick(ev, mode) {
  if (!S.result) return null;
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction; const sz = boxSize(); const [I, J, K] = S.shape, v = S.voxel; const r = S.result;
  let a = 0, b = 1e9;
  for (const ax of ['x', 'y', 'z']) {
    const lo = -sz[ax] / 2, hi = sz[ax] / 2;
    if (Math.abs(d[ax]) < 1e-12) { if (o[ax] < lo || o[ax] > hi) return null; continue; }
    let t0 = (lo - o[ax]) / d[ax], t1 = (hi - o[ax]) / d[ax]; if (t0 > t1) [t0, t1] = [t1, t0];
    a = Math.max(a, t0); b = Math.min(b, t1);
  }
  if (a >= b) return null;
  const step = 0.25 * Math.min(...v); const vis = k => L[k].visible && L[k].obj;
  const thr = (volMat ? volMat.uniforms.uLo.value : 0.3) * 255;
  let rootHit = null; const look = 10 * Math.min(...v);
  for (let t = a; t <= b; t += step) {
    if (rootHit && t - rootHit.t > look) return rootHit.hit;
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    const i = Math.floor(x / v[0] + I / 2), k = Math.floor(y / v[2] + K / 2), j = Math.floor(-z / v[1] + J / 2);
    if (i < 0 || j < 0 || k < 0 || i >= I || j >= J || k >= K) continue;
    const idx = (i * J + j) * K + k; const vox = [i, j, k];
    if (mode === 'erase') { if (r.maskVol[idx] || r.skLab[idx]) return { vox }; continue; }
    if (mode === 'add') { if (S.tex[idx] > thr || r.maskVol[idx]) return { vox }; continue; }
    const c = r.clsVol[idx];
    if ((c === 2 && vis('markers')) || (c === 4 && vis('excluded')) || (c === 3 && vis('noise'))) return { kind: 'object', id: r.cand[idx], vox };
    if (r.blobs[idx] && vis('water')) return { kind: 'blob', id: r.blobs[idx], vox };
    if (vis('skel')) for (const [p, q, s] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const ii = i + p, jj = j + q, kk = k + s; if (ii < 0 || jj < 0 || kk < 0 || ii >= I || jj >= J || kk >= K) continue;
      const sid = r.skLab[(ii * J + jj) * K + kk]; if (sid) return { kind: 'skeleton', id: sid, vox };
    }
    if (r.maskVol[idx] && vis('root') && !rootHit) rootHit = { t, hit: { kind: 'root', id: 1, vox } };
  }
  return rootHit ? rootHit.hit : null;
}
function voxelsWhere(test) { const r = S.result; const out = []; for (let i = 0; i < r.maskVol.length; i++) if (test(i)) out.push(i); return out; }
function select(hit) {
  const r = S.result; if (!r) return;
  if (!hit) { $('selInfo').textContent = 'Nothing under the cursor — try again on a visible object.'; return; }
  let vox, desc;
  if (hit.kind === 'object') {
    vox = voxelsWhere(i => r.cand[i] === hit.id); const c = r.clsVol[vox[0]];
    desc = `${E.CLASS_NAMES[c]} #${hit.id} — ${vox.length} voxels`;
  } else if (hit.kind === 'blob') {
    vox = voxelsWhere(i => r.blobs[i] === hit.id); const info = r.blobInfo.find(b => b.id === hit.id) || {};
    desc = `water blob #${hit.id} — ${vox.length} voxels — ${info.action || ''}`;
  } else if (hit.kind === 'skeleton') {
    vox = voxelsWhere(i => r.skLab[i] === hit.id); const ax = r.axes.find(a => a.id === hit.id); const row = r.roots.find(x => x.root_id === hit.id) || {};
    desc = `${ax.type} root #${hit.id} — ${ax.length.toFixed(0)} mm long, tip at ${row.tip_depth_mm ?? '?'} mm depth`;
    document.querySelectorAll('#tblRoots tr').forEach(tr => tr.classList.toggle('picked', +tr.dataset.id === hit.id));
  } else { vox = []; desc = 'main root system (use the Erase tool to remove parts of it)'; }
  const [I, J, K] = S.shape;
  const anchor = vox.length ? (() => { const idx = vox[Math.floor(vox.length / 2)]; return [Math.floor(idx / (J * K)), Math.floor(idx / K) % J, idx % K]; })() : hit.vox;
  S.selection = { ...hit, anchor, desc };
  $('selInfo').textContent = 'Selected: ' + desc;
  let showVox = vox;
  if (hit.kind === 'skeleton') { // thicken for visibility
    const set = new Set(vox); for (const idx of vox) for (const dlt of [1, -1, K, -K, J * K, -J * K]) set.add(idx + dlt); showVox = [...set];
  }
  const sel = cubes(showVox.slice(0, 40000), COL.sel);
  if (sel) { sel.material.depthTest = false; sel.renderOrder = 10; }
  setLayer('sel', sel);
}
let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  if (S.tool === 'erase' || S.tool === 'add') {
    const hit = pick(e, S.tool); if (!hit) { status('Nothing to ' + S.tool + ' there.'); return; }
    const rad = +$('toolRadius').value || 3;
    S.entries.push({ kind: 'sphere', vox: hit.vox, r: rad, mode: S.tool, desc: `${S.tool === 'erase' ? '⌫ erased' : '＋ added'} sphere r=${rad} at ${hit.vox.join(',')}` });
    refreshEdits(); runAnalysis();
  }
});
canvas.addEventListener('dblclick', e => { if (S.tool === 'select') select(pick(e, 'select')); });
document.querySelectorAll('[data-tool]').forEach(b => {
  b.onclick = () => { S.tool = b.dataset.tool; document.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b)); canvas.style.cursor = S.tool === 'select' ? 'default' : 'crosshair'; };
});

function mark(action) {
  const s = S.selection;
  if (!s) { $('selInfo').textContent = 'Select something first (double-click in the 3D view).'; return; }
  if (s.kind === 'skeleton' || s.kind === 'root') { $('selInfo').textContent = 'Parts of the main root system can’t be toggled as a whole — use the Erase tool instead.'; return; }
  S.entries.push({ kind: 'point', vox: s.anchor, action, desc: `${action === 'root' ? '✓ root' : '✗ non-root'}: ${s.desc.split(' — ')[0]}` });
  refreshEdits(); runAnalysis();
}
$('btnRoot').onclick = () => mark('root');
$('btnNonroot').onclick = () => mark('nonroot');
$('btnUndo').onclick = () => { if (S.entries.length) { S.entries.pop(); refreshEdits(); runAnalysis(); } };
$('btnClear').onclick = () => { S.entries = []; refreshEdits(); runAnalysis(); };
function refreshEdits() { $('editList').textContent = 'Corrections: ' + (S.entries.length ? S.entries.map(e => e.desc).join(' · ') : 'none'); }

// ------------------------------------------------------------------ compare runs
let pickedRun = null;
$('btnSaveRun').onclick = () => {
  const r = S.result; if (!r) return;
  const i = S.runs.length; const color = RUN_COLORS[i % RUN_COLORS.length];
  const name = $('runName').value.trim() || `Run ${i + 1} (${r.params.lo}/${r.params.hi}${r.params.water_filter ? ', water' : ''})`;
  const obj = tubes(r.axes, () => new THREE.Color(color).getHex(), 0.55 * Math.min(...S.voxel)); obj.visible = false; scene.add(obj);
  S.runs.push({ name, color, obj, visible: false, params: { ...r.params }, entries: S.entries.slice(), traits: r.traits, roots: r.roots, axes: r.axes });
  $('runName').value = ''; refreshRuns(); buildLayerPanel();
};
function refreshRuns() {
  const t = $('tblRuns');
  t.innerHTML = '<tr><th>Show</th><th>Run</th>' + KEY_TRAITS.map(([, l]) => `<th>${l}</th>`).join('') + '</tr>' +
    S.runs.map((r, i) => `<tr class="click ${pickedRun === i ? 'picked' : ''}" data-i="${i}"><td><input type="checkbox" ${r.visible ? 'checked' : ''}></td><td style="color:${r.color}">${r.name}</td>` +
      KEY_TRAITS.map(([k]) => `<td class="n">${fmt(r.traits[k], 0)}</td>`).join('') + '</tr>').join('');
  t.querySelectorAll('tr.click').forEach(tr => {
    const i = +tr.dataset.i; const cb = tr.querySelector('input');
    cb.onclick = e => { e.stopPropagation(); S.runs[i].visible = cb.checked; S.runs[i].obj.visible = cb.checked; buildLayerPanel(); };
    tr.onclick = () => { pickedRun = i; refreshRuns(); };
  });
}
$('btnLoadRun').onclick = () => { if (pickedRun === null) return; const r = S.runs[pickedRun]; setParams(r.params); S.entries = r.entries.slice(); refreshEdits(); runAnalysis(); };
$('btnDelRun').onclick = () => { if (pickedRun === null) return; disposeObj(S.runs[pickedRun].obj); S.runs.splice(pickedRun, 1); pickedRun = null; refreshRuns(); buildLayerPanel(); };

// ------------------------------------------------------------------ export
const EXPORTS = [
  ['traits', 'Traits table — all saved runs + current (traits.csv)', true],
  ['roots', 'Per-root table (roots.csv, one per saved run too)', true],
  ['json', 'Traits + settings + water-blob report + corrections (traits.json)', true],
  ['mat', 'Segmentation volumes for MATLAB (segmentation.mat)', true],
  ['rsml', 'Root architecture, RSML format (roots.rsml)', true],
  ['html', 'Interactive 3D page to share (viewer.html)', true],
  ['png', 'Screenshot of the current view (screenshot.png)', true],
];
$('exportOpts').innerHTML = EXPORTS.map(([k, l, on]) => `<label><input type="checkbox" id="ex_${k}" ${on ? 'checked' : ''}> ${l}</label>`).join('');
const safe = s => s.replace(/[^\w.-]+/g, '_').slice(0, 50);

function standaloneHTML(r, title) {
  const v = r.params.voxel; const traces = [];
  const mesh = (ms, color, op, name, byH) => {
    if (!ms.pos.length) return;
    const x = [], y = [], z = []; for (let t = 0; t < ms.pos.length; t += 3) { x.push(+(ms.pos[t] * v[0]).toFixed(1)); y.push(+(ms.pos[t + 1] * v[1]).toFixed(1)); z.push(+(ms.pos[t + 2] * v[2]).toFixed(1)); }
    const i = [], j = [], k = []; for (let t = 0; t < ms.idx.length; t += 3) { i.push(ms.idx[t]); j.push(ms.idx[t + 1]); k.push(ms.idx[t + 2]); }
    traces.push(Object.assign({ type: 'mesh3d', x, y, z, i, j, k, opacity: op, name, showlegend: true, hoverinfo: 'skip', lighting: { ambient: 0.55, diffuse: 0.8, specular: 0.25 } },
      byH ? { intensity: z, colorscale: [[0, '#6b4a2b'], [0.5, '#c79b6b'], [1, '#f3e3c7']], showscale: false } : { color }));
  };
  mesh(r.meshes.root, null, 0.42, 'Root surface', true); mesh(r.meshes.water, '#4fa3ff', 0.35, 'Water removed'); mesh(r.meshes.markers, '#8a8178', 0.6, 'Markers');
  for (const [t, col, wd] of [['main', '#f2b45a', 6], ['lateral', '#5fd0c0', 3.5], ['fragment', '#c98bd6', 3.5]]) {
    const x = [], y = [], z = [], txt = [];
    for (const a of r.axes) if (a.type === t) { for (const q of a.pts) { x.push(q[0] * v[0]); y.push(q[1] * v[1]); z.push(q[2] * v[2]); txt.push(`${t} #${a.id}: ${a.length.toFixed(0)} mm`); } x.push(null); y.push(null); z.push(null); txt.push(''); }
    if (x.length) traces.push({ type: 'scatter3d', mode: 'lines', x, y, z, text: txt, hoverinfo: 'text', name: t, line: { color: col, width: wd } });
  }
  const rows = Object.entries(NICE).map(([k, l]) => `<tr><td>${l}</td><td style="text-align:right"><b>${fmt(r.traits[k])}</b></td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><script src="https://cdn.plot.ly/plotly-2.35.2.min.js"><\/script>
<style>body{margin:0;background:#15120f;color:#efe7dc;font-family:Segoe UI,Arial,sans-serif;display:flex;flex-wrap:wrap}#v{flex:1 1 700px;height:100vh}#t{flex:0 0 340px;padding:20px;font-size:13px}td{padding:5px 8px;border-bottom:1px solid #2f2924}table{border-collapse:collapse;width:100%}</style></head>
<body><div id="v"></div><div id="t"><h3>${title}</h3><table>${rows}</table><p style="color:#a39889">Exported from Root Viewer. Drag to rotate, click legend items to toggle.</p></div>
<script>const ax={showbackground:false,gridcolor:'#2b2520',color:'#7d7366',title:''};Plotly.newPlot('v',${JSON.stringify(traces)},{template:'plotly_dark',paper_bgcolor:'#15120f',margin:{l:0,r:0,t:10,b:0},scene:{aspectmode:'data',xaxis:ax,yaxis:ax,zaxis:ax,camera:{eye:{x:1.6,y:1.3,z:0.55}}},legend:{x:0.01,y:0.98}},{displaylogo:false});<\/script></body></html>`;
}

$('btnExport').onclick = async () => {
  const r = S.result; if (!r) return;
  busy('Preparing export…');
  try {
    const files = []; const name = S.fileName || 'scan';
    const runs = S.runs.map(x => [x.name, x]).concat([['current', r]]);
    if ($('ex_traits').checked) files.push({ name: 'traits.csv', data: E.traitsCSV(runs) });
    if ($('ex_roots').checked) { files.push({ name: 'roots.csv', data: E.rootsCSV(r) }); S.runs.forEach(x => files.push({ name: `roots_${safe(x.name)}.csv`, data: E.rootsCSV(x) })); }
    if ($('ex_json').checked) files.push({ name: 'traits.json', data: JSON.stringify({ file: name, ...r.traits, water_blobs: r.blobInfo, params: r.params, corrections: S.entries.map(e => e.desc) }, null, 2) });
    if ($('ex_mat').checked) {
      const b = await E.writeMat([
        { name: 'root_mask', data: r.maskVol, shape: r.shape, cls: 'uint8' },
        { name: 'root_mask_topology', data: r.mask, shape: r.shape, cls: 'uint8' },
        { name: 'skeleton_root_id', data: r.skLab, shape: r.shape, cls: 'int16' },
        { name: 'water_blobs', data: r.blobs, shape: r.shape, cls: 'int16' },
        { name: 'object_class', data: r.clsVol, shape: r.shape, cls: 'uint8' },
        { name: 'tips_voxel', data: Float64Array.from(r.tips.flat()), shape: [r.tips.length, 3], cls: 'double' },
        { name: 'branch_points_voxel', data: Float64Array.from(r.branchPts.flat()), shape: [r.branchPts.length, 3], cls: 'double' },
      ]);
      files.push({ name: 'segmentation.mat', data: new Uint8Array(await b.arrayBuffer()) });
    }
    if ($('ex_rsml').checked) files.push({ name: 'roots.rsml', data: E.rsml(r, name) });
    if ($('ex_html').checked) files.push({ name: 'viewer.html', data: standaloneHTML(r, name) });
    if ($('ex_png').checked) {
      renderer.render(scene, camera);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      files.push({ name: 'screenshot.png', data: new Uint8Array(await blob.arrayBuffer()) });
    }
    files.push({ name: 'README.txt', data: `Root Viewer export for ${name}\nobject_class codes: ${Object.entries(E.CLASS_NAMES).map(([k, v]) => k + '=' + v).join(', ')}\nVolumes are in the analysis orientation (3rd axis vertical, plant base at high index).\n` });
    const zip = E.makeZip(files);
    const a = document.createElement('a'); a.href = URL.createObjectURL(zip); a.download = `root_results_${safe(name)}.zip`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    status(`Exported ${files.length} files.`);
  } catch (e) { status('⚠ Export failed: ' + e.message, true); }
  busy(false);
};

// ------------------------------------------------------------------ help & init
$('btnHelp').onclick = () => { $('help').hidden = false; };
$('helpClose').onclick = () => { $('help').hidden = true; };
$('help').onclick = e => { if (e.target === $('help')) $('help').hidden = true; };
buildParamForm(); buildLayerPanel(); refreshRuns();
window.__rootViewer = { S, L, select, pick, loadFile, setView, camera, controls }; // for debugging / automation
