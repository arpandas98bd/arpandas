// worker.js — runs the analysis off the main thread so the page stays responsive.
import * as E from './engine.js';

let vars = [], vol = null, cache = {};
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const progress = msg => post('progress', { msg });

function percentiles(data, ps) {
  const n = data.length, step = Math.max(1, Math.floor(n / 400000));
  const s = []; for (let i = 0; i < n; i += step) s.push(data[i]);
  s.sort((a, b) => a - b);
  return ps.map(p => s[Math.min(s.length - 1, Math.max(0, Math.round(p / 100 * (s.length - 1))))]);
}

function displayTexture(v) {
  const [p1, p993, p9998, p99995] = percentiles(v.data, [1, 99.3, 99.98, 99.995]);
  const lo = p1, hi = Math.max(p99995, p1 + 1e-9);
  const tex = new Uint8Array(v.data.length);
  for (let i = 0; i < tex.length; i++) tex[i] = Math.max(0, Math.min(255, Math.round((v.data[i] - lo) / (hi - lo) * 255)));
  return { tex, winLo: (p993 - lo) / (hi - lo), winHi: Math.min(1, (p9998 - lo) / (hi - lo)) };
}

function voxels(mask, value, shape, cap = 60000) { // list voxel indices for instanced cubes
  const out = []; for (let i = 0; i < mask.length && out.length < cap; i++) if (mask[i] === value) out.push(i);
  return Int32Array.from(out);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'load') {
      progress('Reading .mat file…');
      vars = (await E.readMat(m.buffer)).filter(v => v.dims.length >= 3 && v.dims.filter(d => d > 1).length === 3);
      if (!vars.length) throw new Error('No 3D image found in this .mat file.');
      post('vars', { vars: vars.map(v => ({ name: v.name, dims: v.dims })) });
    } else if (m.cmd === 'open') {
      const v = vars.find(x => x.name === m.varName) || vars[0];
      vol = E.toVolume(v, m.vertical, m.baseHigh); cache = {};
      const { tex, winLo, winHi } = displayTexture(vol);
      post('volume', { shape: vol.shape, tex, winLo, winHi }, [tex.buffer]);
    } else if (m.cmd === 'analyze') {
      const t0 = performance.now();
      const r = E.analyze(vol, m.params, m.edits, cache, progress);
      progress('Building 3D surfaces…');
      const N = r.maskVol.length;
      const water = new Uint8Array(N);
      for (let i = 0; i < N; i++) water[i] = (r.mask[i] && !r.maskVol[i]) || r.clsVol[i] === 5 ? 1 : 0;
      const sel = c => { const a = new Uint8Array(N); for (let i = 0; i < N; i++) a[i] = r.clsVol[i] === c ? 1 : 0; return a; };
      const meshes = {
        root: E.surfaceMesh(r.maskVol, r.shape),
        water: E.surfaceMesh(water, r.shape, 0.35),
        markers: E.surfaceMesh(sel(2), r.shape),
        excluded: E.surfaceMesh(sel(4), r.shape),
      };
      const noise = voxels(r.clsVol, 3, r.shape);
      const pack = {
        params: r.params, shape: r.shape, traits: r.traits, roots: r.roots, blobInfo: r.blobInfo,
        axes: r.axes, tips: r.tips, branchPts: r.branchPts,
        cand: r.cand, clsVol: r.clsVol, blobs: Int16Array.from(r.blobs), skLab: Int16Array.from(r.skLab),
        maskVol: r.maskVol, mask: r.mask, meshes, noise, seconds: (performance.now() - t0) / 1000,
      };
      const tr = [pack.cand.buffer, pack.clsVol.buffer, pack.blobs.buffer, pack.skLab.buffer, pack.maskVol.buffer, pack.mask.buffer, noise.buffer];
      for (const ms of Object.values(meshes)) tr.push(ms.pos.buffer, ms.idx.buffer);
      post('result', { result: pack }, tr);
    }
  } catch (err) {
    post('error', { msg: err.message || String(err) });
  }
};
