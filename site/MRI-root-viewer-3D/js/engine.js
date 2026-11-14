// engine.js — root system analysis for 3D MRI volumes, in plain JavaScript.
// A port of root_analysis.py (Python). Runs in a browser Web Worker or in Node.
// Volumes are flat typed arrays in C order: index = (i*J + j)*K + k,
// with axis 2 (k) vertical and the plant base at the HIGH k end.

export const DEFAULTS = {
  voxel: [2, 2, 2], sigma: 0.7, lo: 3, hi: 6, n_markers: 2, min_frag: 40, frag_dist: 8,
  water_filter: true, blob_ratio: 1.0, min_blob: 20, crown_protect: 10,
  crown: 20, min_main: 20, min_lat: 5, spur: 4,
};
export const CLASS_NAMES = { 1: 'root', 2: 'marker', 3: 'detached noise', 4: 'excluded by you', 5: 'water blob' };

const N26 = [];
for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) if (a || b || c) N26.push([a, b, c]);
const N6 = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];

// ===================================================================== MAT-file reading (v5 / v7)
const MI = { INT8: 1, UINT8: 2, INT16: 3, UINT16: 4, INT32: 5, UINT32: 6, SINGLE: 7, DOUBLE: 9, INT64: 12, UINT64: 13, MATRIX: 14, COMPRESSED: 15, UTF8: 16 };

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const chunks = []; const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
  } catch (e) { if (!total) throw e; /* MATLAB sometimes appends bytes after the zlib stream */ }
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function readTyped(dv, off, type, nbytes) {
  const buf = dv.buffer.slice(dv.byteOffset + off, dv.byteOffset + off + nbytes);
  switch (type) {
    case MI.INT8: return new Int8Array(buf); case MI.UINT8: return new Uint8Array(buf);
    case MI.INT16: return new Int16Array(buf); case MI.UINT16: return new Uint16Array(buf);
    case MI.INT32: return new Int32Array(buf); case MI.UINT32: return new Uint32Array(buf);
    case MI.SINGLE: return new Float32Array(buf); case MI.DOUBLE: return new Float64Array(buf);
    case MI.INT64: return Float64Array.from(new BigInt64Array(buf), Number);
    case MI.UINT64: return Float64Array.from(new BigUint64Array(buf), Number);
    case MI.UTF8: return new Uint8Array(buf);
    default: throw new Error('Unsupported MAT data type ' + type);
  }
}

function readTag(dv, off) {
  const t = dv.getUint32(off, true);
  if (t >> 16) return { type: t & 0xffff, nbytes: t >> 16, data: off + 4, next: off + 8 };
  const nb = dv.getUint32(off + 4, true);
  return { type: t, nbytes: nb, data: off + 8, next: off + 8 + Math.ceil(nb / 8) * 8 };
}

function parseMatrix(dv, off, end) {
  // sub-elements: flags, dims, name, real, [imag]
  let tag = readTag(dv, off);
  const flags = dv.getUint32(tag.data, true);
  const cls = flags & 0xff; const complex = !!(flags & 0x800);
  off = tag.next;
  tag = readTag(dv, off);
  const dims = Array.from(readTyped(dv, tag.data, tag.type, tag.nbytes));
  off = tag.next;
  tag = readTag(dv, off);
  const name = new TextDecoder().decode(readTyped(dv, tag.data, MI.UINT8, tag.nbytes));
  off = tag.next;
  if (cls < 6 || cls > 15) return { name, dims, cls, data: null };
  tag = readTag(dv, off);
  let data = readTyped(dv, tag.data, tag.type, tag.nbytes);
  if (complex) {
    const t2 = readTag(dv, tag.next);
    const im = readTyped(dv, t2.data, t2.type, t2.nbytes);
    const mag = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) mag[i] = Math.hypot(data[i], im[i]);
    data = mag;
  }
  return { name, dims, cls, data };
}

/** Parse a MATLAB .mat file. Returns [{name, dims, data}] (data column-major). */
export async function readMat(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const head = new TextDecoder().decode(u8.slice(0, 116));
  if (head.includes('7.3') || (u8[512] === 0x89 && u8[513] === 0x48)) {
    throw new Error('This is a MATLAB v7.3 (HDF5) file. Please re-save it in MATLAB with:  save(\'file.mat\', \'im\', \'-v7\')');
  }
  if (u8[126] !== 0x49 || u8[127] !== 0x4d) throw new Error('Not a little-endian MATLAB v5/v7 .mat file.');
  const dv = new DataView(arrayBuffer);
  const vars = [];
  let off = 128;
  while (off + 8 <= u8.length) {
    const type = dv.getUint32(off, true); const nb = dv.getUint32(off + 4, true);
    if (type === MI.COMPRESSED) {
      const raw = await inflate(u8.subarray(off + 8, off + 8 + nb));
      const dv2 = new DataView(raw.buffer);
      const t2 = dv2.getUint32(0, true); const nb2 = dv2.getUint32(4, true);
      if (t2 === MI.MATRIX) vars.push(parseMatrix(dv2, 8, 8 + nb2));
      off += 8 + nb;
    } else {
      if (type === MI.MATRIX) vars.push(parseMatrix(dv, off + 8, off + 8 + nb));
      off += 8 + Math.ceil(nb / 8) * 8;
    }
  }
  return vars.filter(v => v.data);
}

/** Column-major MATLAB array -> C-order Float32Array with the vertical axis last. */
export function toVolume(v, verticalAxis = 2, baseHigh = true) {
  const d = v.dims.slice(0, 3); while (d.length < 3) d.push(1);
  const order = [0, 1, 2].filter(a => a !== verticalAxis).concat([verticalAxis]);
  const shape = order.map(a => d[a]);
  const [I, J, K] = shape;
  const out = new Float32Array(I * J * K);
  const strideF = [1, d[0], d[0] * d[1]];
  const s0 = strideF[order[0]], s1 = strideF[order[1]], s2 = strideF[order[2]];
  for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) {
    const base = (i * J + j) * K; const fb = i * s0 + j * s1;
    for (let k = 0; k < K; k++) {
      const kk = baseHigh ? k : K - 1 - k;
      out[base + k] = v.data[fb + kk * s2];
    }
  }
  return { data: out, shape };
}

// ===================================================================== filters
function gaussKernel(sigma, order, truncate) {
  const r = Math.floor(truncate * sigma + 0.5);
  const k = new Float64Array(2 * r + 1); let s = 0;
  for (let x = -r; x <= r; x++) { const v = Math.exp(-0.5 * x * x / (sigma * sigma)); k[x + r] = v; s += v; }
  for (let t = 0; t < k.length; t++) k[t] /= s;
  if (order === 1) for (let x = -r; x <= r; x++) k[x + r] *= -x / (sigma * sigma);
  if (order === 2) for (let x = -r; x <= r; x++) k[x + r] *= (x * x / sigma ** 4 - 1 / sigma ** 2);
  return { k, r };
}

function reflectIdx(i, n) { // scipy 'reflect': d c b a | a b c d | d c b a
  if (n === 1) return 0;
  const p = 2 * n;
  i = ((i % p) + p) % p;
  return i < n ? i : p - i - 1;
}

/** 1D convolution along one axis. mode: 'reflect' | 'constant' (cval 0) */
function filterAxis(src, shape, axis, kern, mode) {
  const [I, J, K] = shape; const n = shape[axis];
  const stride = axis === 0 ? J * K : axis === 1 ? K : 1;
  const dst = new Float32Array(src.length);
  const { k, r } = kern;
  const line = new Float64Array(n);
  const outer = axis === 0 ? [J, K] : axis === 1 ? [I, K] : [I, J];
  for (let a = 0; a < outer[0]; a++) for (let b = 0; b < outer[1]; b++) {
    const start = axis === 0 ? a * K + b : axis === 1 ? a * J * K + b : (a * J + b) * K;
    for (let t = 0; t < n; t++) line[t] = src[start + t * stride];
    for (let t = 0; t < n; t++) {
      let acc = 0;
      if (t >= r && t < n - r) { // interior: no bounds checks
        for (let x = -r, q = t + r; x <= r; x++, q--) acc += k[x + r] * line[q];
      } else {
        for (let x = -r; x <= r; x++) {
          let q = t - x;
          if (q < 0 || q >= n) { if (mode === 'constant') continue; q = reflectIdx(q, n); }
          acc += k[x + r] * line[q];
        }
      }
      dst[start + t * stride] = acc;
    }
  }
  return dst;
}

export function gaussian3d(src, shape, sigma, orders = [0, 0, 0], mode = 'reflect', truncate = 4) {
  let out = src;
  for (let ax = 0; ax < 3; ax++) {
    if (sigma <= 0 && orders[ax] === 0) continue;
    out = filterAxis(out, shape, ax, gaussKernel(sigma, orders[ax], truncate), mode);
  }
  return out === src ? Float32Array.from(src) : out;
}

function median(arr) { // numpy-style median (mean of the two middle values for even n)
  const a = Float64Array.from(arr).sort(); const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

/** Smooth, then per horizontal slice (fixed k): (x - median) / (1.4826 * MAD). */
export function normalise(vol, sigma) {
  const { shape } = vol; const [I, J, K] = shape;
  const sm = gaussian3d(vol.data, shape, sigma, [0, 0, 0], 'reflect', 4);
  const z = new Float32Array(sm.length); const sl = new Float64Array(I * J);
  for (let k = 0; k < K; k++) {
    for (let p = 0; p < I * J; p++) sl[p] = sm[p * K + k];
    const med = median(sl);
    for (let p = 0; p < I * J; p++) sl[p] = Math.abs(sm[p * K + k] - med);
    const mad = Math.max(median(sl) * 1.4826, 1e-12);
    for (let p = 0; p < I * J; p++) z[p * K + k] = (sm[p * K + k] - med) / mad;
  }
  return z;
}

// ===================================================================== labeling & morphology
/** Connected components (6 or 26 connectivity); labels numbered in raster order like scipy. */
export function label(mask, shape, conn = 26) {
  const [I, J, K] = shape; const N = mask.length;
  const lab = new Int32Array(N); const parent = [0];
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const back = conn === 26 ? N26.filter(([a, b, c]) => a < 0 || (a === 0 && (b < 0 || (b === 0 && c < 0))))
    : [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
  let next = 1;
  for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) for (let k = 0; k < K; k++) {
    const idx = (i * J + j) * K + k; if (!mask[idx]) continue;
    let m = 0;
    for (const [a, b, c] of back) {
      const ii = i + a, jj = j + b, kk = k + c;
      if (ii < 0 || jj < 0 || kk < 0 || jj >= J || kk >= K) continue;
      const l = lab[(ii * J + jj) * K + kk]; if (!l) continue;
      const rl = find(l);
      if (!m) m = rl; else if (rl !== m) { const lo = Math.min(m, rl), hi = Math.max(m, rl); parent[hi] = lo; m = lo; }
    }
    if (!m) { m = next++; parent.push(m); }
    lab[idx] = m;
  }
  const remap = new Int32Array(next); let n = 0;
  for (let idx = 0; idx < N; idx++) {
    const l = lab[idx]; if (!l) continue;
    const r = find(l);
    if (!remap[r]) remap[r] = ++n;
    lab[idx] = remap[r];
  }
  return { labels: lab, n };
}

function counts(labels, n) { const s = new Int32Array(n + 1); for (let i = 0; i < labels.length; i++) s[labels[i]]++; s[0] = 0; return s; }

export function hysteresis(z, lo, hi, shape) {
  const low = new Uint8Array(z.length);
  for (let i = 0; i < z.length; i++) low[i] = z[i] > lo ? 1 : 0;
  const { labels, n } = label(low, shape, 6);
  const ok = new Uint8Array(n + 1);
  for (let i = 0; i < z.length; i++) if (z[i] > hi) ok[labels[i]] = 1;
  ok[0] = 0;
  const out = new Uint8Array(z.length);
  for (let i = 0; i < z.length; i++) out[i] = ok[labels[i]];
  return out;
}

function shiftLoop(shape, fn) {
  const [I, J, K] = shape;
  for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) for (let k = 0; k < K; k++) fn(i, j, k, (i * J + j) * K + k);
}

/** Binary dilation with 6- or 26-neighbourhood (constant 0 outside). */
export function dilate(mask, shape, conn = 26, iterations = 1) {
  const [I, J, K] = shape; const nb = conn === 26 ? N26 : N6;
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const out = Uint8Array.from(cur);
    shiftLoop(shape, (i, j, k, idx) => {
      if (!cur[idx]) return;
      for (const [a, b, c] of nb) {
        const ii = i + a, jj = j + b, kk = k + c;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= I || jj >= J || kk >= K) continue;
        out[(ii * J + jj) * K + kk] = 1;
      }
    });
    cur = out;
  }
  return cur;
}

/** Closing with ball(1) (6-neighbour cross), border handled like skimage mode='reflect'. */
function closingBall1(mask, shape) {
  const [I, J, K] = shape;
  const get = (src, i, j, k) => src[(Math.min(Math.max(i, 0), I - 1) * J + Math.min(Math.max(j, 0), J - 1)) * K + Math.min(Math.max(k, 0), K - 1)];
  const dil = new Uint8Array(mask.length);
  shiftLoop(shape, (i, j, k, idx) => {
    let v = mask[idx];
    if (!v) for (const [a, b, c] of N6) if (get(mask, i + a, j + b, k + c)) { v = 1; break; }
    dil[idx] = v;
  });
  const ero = new Uint8Array(mask.length);
  shiftLoop(shape, (i, j, k, idx) => {
    let v = dil[idx];
    if (v) for (const [a, b, c] of N6) if (!get(dil, i + a, j + b, k + c)) { v = 0; break; }
    ero[idx] = v;
  });
  return ero;
}

/** scipy binary_fill_holes (6-connected background from the border). */
function fillHoles(mask, shape) {
  const [I, J, K] = shape; const reached = new Uint8Array(mask.length);
  const q = new Int32Array(mask.length); let h = 0, t = 0;
  shiftLoop(shape, (i, j, k, idx) => {
    if ((i === 0 || j === 0 || k === 0 || i === I - 1 || j === J - 1 || k === K - 1) && !mask[idx]) { reached[idx] = 1; q[t++] = idx; }
  });
  while (h < t) {
    const idx = q[h++]; const k = idx % K, j = ((idx - k) / K) % J, i = Math.floor(idx / (J * K));
    for (const [a, b, c] of N6) {
      const ii = i + a, jj = j + b, kk = k + c;
      if (ii < 0 || jj < 0 || kk < 0 || ii >= I || jj >= J || kk >= K) continue;
      const n = (ii * J + jj) * K + kk;
      if (!mask[n] && !reached[n]) { reached[n] = 1; q[t++] = n; }
    }
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] || !reached[i] ? 1 : 0;
  return out;
}

/** Exact squared Euclidean distance to the nearest `feature` voxel (Felzenszwalb). */
export function edt2(feature, shape) {
  const [I, J, K] = shape; const INF = 1e20;
  const d = new Float64Array(feature.length);
  for (let i = 0; i < d.length; i++) d[i] = feature[i] ? 0 : INF;
  const pass = (n, getIdx) => {
    const f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    return (base) => {
      for (let q = 0; q < n; q++) f[q] = d[getIdx(base, q)];
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < n; q++) {
        let s;
        for (;;) {
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
        }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + f[v[k]]; }
      for (let q = 0; q < n; q++) d[getIdx(base, q)] = out[q];
    };
  };
  const pk = pass(K, (b, q) => b + q); for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) pk((i * J + j) * K);
  const pj = pass(J, (b, q) => b + q * K); for (let i = 0; i < I; i++) for (let k = 0; k < K; k++) pj(i * J * K + k);
  const pi = pass(I, (b, q) => b + q * J * K); for (let j = 0; j < J; j++) for (let k = 0; k < K; k++) pi(j * K + k);
  return d;
}

// ===================================================================== Hessian tube/blob maps
function symEig3(a, b, c, d, e, f) { // [[a,d,e],[d,b,f],[e,f,c]]
  const p1 = d * d + e * e + f * f;
  if (p1 < 1e-30) return [a, b, c];
  const q = (a + b + c) / 3;
  const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B11 = (a - q) / p, B22 = (b - q) / p, B33 = (c - q) / p, B12 = d / p, B13 = e / p, B23 = f / p;
  let r = (B11 * (B22 * B33 - B23 * B23) - B12 * (B12 * B33 - B23 * B13) + B13 * (B12 * B23 - B22 * B13)) / 2;
  r = Math.max(-1, Math.min(1, r));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi), e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  return [e1, 3 * q - e1 - e3, e3];
}

/** Multi-scale Hessian blob-ness and tube-ness (like skimage hessian_matrix, mode constant). */
export function hessianShape(z, shape, sigmas = [1.0, 1.5, 2.0, 3.0], clip = 40, progress) {
  const n = z.length; const zc = new Float32Array(n);
  for (let i = 0; i < n; i++) zc[i] = Math.min(Math.max(z[i], 0), clip);
  const B = new Float32Array(n), T = new Float32Array(n);
  const pairs = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
  for (const s of sigmas) {
    progress && progress(`Shape analysis, scale ${s}…`);
    const ss = s / Math.SQRT2;
    const e = d => [0, 1, 2].map(x => (x === d ? 1 : 0));
    const grads = [0, 1, 2].map(d => gaussian3d(zc, shape, ss, e(d), 'constant', 8));
    const H = pairs.map(([a, b]) => gaussian3d(grads[a], shape, ss, e(b), 'constant', 8));
    const [Hxx, Hxy, Hxz, Hyy, Hyz, Hzz] = H;
    for (let i = 0; i < n; i++) {
      let [l1, l2, l3] = symEig3(Hxx[i], Hyy[i], Hzz[i], Hxy[i], Hxz[i], Hyz[i]);
      if (Math.abs(l1) > Math.abs(l2)) [l1, l2] = [l2, l1];
      if (Math.abs(l2) > Math.abs(l3)) [l2, l3] = [l3, l2];
      if (Math.abs(l1) > Math.abs(l2)) [l1, l2] = [l2, l1];
      const bright = l2 < 0 && l3 < 0;
      if (!bright) continue;
      const Rb = Math.abs(l1) / Math.sqrt(Math.abs(l2 * l3) + 1e-9);
      const Ra = Math.abs(l2) / (Math.abs(l3) + 1e-9);
      const S = Math.sqrt(l1 * l1 + l2 * l2 + l3 * l3) * s * s;
      const bv = l1 < 0 ? S * Rb : 0, tv = S * Ra * (1 - Rb);
      if (bv > B[i]) B[i] = bv;
      if (tv > T[i]) T[i] = tv;
    }
  }
  return { B, T };
}

// ===================================================================== 3D skeletonize (Lee 1994) — port of scikit-image
const EULER = new Int32Array(256);
[1, -1, -1, 1, -3, -1, -1, 1, -1, 1, 1, -1, 3, 1, 1, -1, -3, -1, 3, 1, 1, -1, 3, 1, -1, 1, 1, -1, 3, 1, 1, -1, -3, 3, -1, 1, 1,
  3, -1, 1, -1, 1, 1, -1, 3, 1, 1, -1, 1, 3, 3, 1, 5, 3, 3, 1, -1, 1, 1, -1, 3, 1, 1, -1, -7, -1, -1, 1, -3, -1, -1, 1, -1,
  1, 1, -1, 3, 1, 1, -1, -3, -1, 3, 1, 1, -1, 3, 1, -1, 1, 1, -1, 3, 1, 1, -1, -3, 3, -1, 1, 1, 3, -1, 1, -1, 1, 1, -1, 3,
  1, 1, -1, 1, 3, 3, 1, 5, 3, 3, 1, -1, 1, 1, -1, 3, 1, 1, -1].forEach((v, i) => { EULER[2 * i + 1] = v; });
const OCT_IDX = [[2, 1, 11, 10, 5, 4, 14], [0, 9, 3, 12, 1, 10, 4], [8, 7, 17, 16, 5, 4, 14], [6, 15, 7, 16, 3, 12, 4],
  [20, 23, 19, 22, 11, 14, 10], [18, 21, 9, 12, 19, 22, 10], [26, 23, 17, 14, 25, 22, 16], [24, 25, 15, 16, 21, 22, 12]];
const OCTREE = [
  [[0, 1, 3, 4, 9, 10, 12], [[], [2], [3], [2, 3, 4], [5], [2, 5, 6], [3, 5, 7]]],
  [[1, 4, 10, 2, 5, 11, 13], [[1], [1, 3, 4], [1, 5, 6], [], [4], [6], [4, 6, 8]]],
  [[3, 4, 12, 6, 7, 14, 15], [[1], [1, 2, 4], [1, 5, 7], [], [4], [7], [4, 7, 8]]],
  [[4, 5, 13, 7, 15, 8, 16], [[1, 2, 3], [2], [2, 6, 8], [3], [3, 7, 8], [], [8]]],
  [[9, 10, 12, 17, 18, 20, 21], [[1], [1, 2, 6], [1, 3, 7], [], [6], [7], [6, 7, 8]]],
  [[10, 11, 13, 18, 21, 19, 22], [[1, 2, 5], [2], [2, 4, 8], [5], [5, 7, 8], [], [8]]],
  [[12, 14, 15, 20, 21, 23, 24], [[1, 3, 5], [3], [3, 4, 8], [5], [5, 6, 8], [], [8]]],
  [[13, 15, 16, 21, 22, 24, 25], [[2, 4, 6], [3, 4, 7], [4], [5, 6, 7], [6], [7], []]],
];
const START_OCT = new Int8Array(26);
[[[0, 1, 3, 4, 9, 10, 12], 1], [[2, 5, 11, 13], 2], [[6, 7, 14, 15], 3], [[8, 16], 4], [[17, 18, 20, 21], 5],
  [[19, 22], 6], [[23, 24], 7], [[25], 8]].forEach(([l, o]) => l.forEach(i => { START_OCT[i] = o; }));

function octreeLabel(octant, lbl, cube) {
  const [idx, nexts] = OCTREE[octant - 1];
  for (let t = 0; t < 7; t++) {
    if (cube[idx[t]] === 1) { cube[idx[t]] = lbl; for (const o of nexts[t]) octreeLabel(o, lbl, cube); }
  }
}
const _cube = new Uint8Array(26);
function isSimple(nb) {
  for (let i = 0; i < 13; i++) _cube[i] = nb[i];
  for (let i = 13; i < 26; i++) _cube[i] = nb[i + 1];
  let lbl = 2;
  for (let i = 0; i < 26; i++) {
    if (_cube[i] === 1) {
      octreeLabel(START_OCT[i], lbl, _cube);
      lbl++;
      if (lbl - 2 >= 2) return false;
    }
  }
  return true;
}
function isEulerInvariant(nb) {
  let e = 0;
  for (let o = 0; o < 8; o++) {
    let n = 1; const ix = OCT_IDX[o];
    for (let j = 0; j < 7; j++) if (nb[ix[j]] === 1) n |= 1 << (7 - j);
    e += EULER[n];
  }
  return e === 0;
}

/** skimage.morphology.skeletonize for 3D (Lee's method). */
export function skeletonize(mask, shape) {
  const [I, J, K] = shape; const P = I + 2, R = J + 2, C = K + 2;
  const img = new Uint8Array(P * R * C);
  let p0 = P, p1 = 0, r0 = R, r1 = 0, c0 = C, c1 = 0;
  shiftLoop(shape, (i, j, k, idx) => {
    if (!mask[idx]) return;
    img[((i + 1) * R + j + 1) * C + k + 1] = 1;
    p0 = Math.min(p0, i + 1); p1 = Math.max(p1, i + 1); r0 = Math.min(r0, j + 1); r1 = Math.max(r1, j + 1); c0 = Math.min(c0, k + 1); c1 = Math.max(c1, k + 1);
  });
  const nb = new Uint8Array(27);
  const off = []; // neighbourhood index -> offset: index = 9*(dp+1) + 3*(dc+1) + (dr+1)
  for (let t = 0; t < 27; t++) { const dp = Math.floor(t / 9) - 1, dc = Math.floor((t % 9) / 3) - 1, dr = (t % 3) - 1; off.push(dp * R * C + dr * C + dc); }
  const getNb = idx => { for (let t = 0; t < 27; t++) nb[t] = img[idx + off[t]]; };
  const borders = [4, 3, 2, 1, 5, 6];
  const bOff = { 1: -1, 2: 1, 3: C, 4: -C, 5: R * C, 6: -R * C };
  if (p1 >= p0) {
    let unchanged = 0;
    while (unchanged < 6) {
      unchanged = 0;
      for (const cb of borders) {
        const cand = []; const bo = bOff[cb];
        for (let p = p0; p <= p1; p++) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const idx = (p * R + r) * C + c;
          if (img[idx] !== 1 || img[idx + bo] !== 0) continue;
          getNb(idx);
          let s = 0; for (let t = 0; t < 27; t++) s += nb[t];
          if (s === 2 || !isEulerInvariant(nb) || !isSimple(nb)) continue;
          cand.push(idx);
        }
        let noChange = true;
        for (const idx of cand) { getNb(idx); if (isSimple(nb)) { img[idx] = 0; noChange = false; } }
        if (noChange) unchanged++;
      }
    }
  }
  const out = new Uint8Array(I * J * K);
  shiftLoop(shape, (i, j, k, idx) => { out[idx] = img[((i + 1) * R + j + 1) * C + k + 1]; });
  return out;
}

// ===================================================================== skeleton graph (skan-like)
export class SkelGraph {
  constructor(sk, shape, spacing = [1, 1, 1]) {
    const [I, J, K] = shape; this.shape = shape;
    const id = new Map(); const coords = [];
    for (let idx = 0; idx < sk.length; idx++) if (sk[idx]) {
      const k = idx % K, j = ((idx - k) / K) % J, i = Math.floor(idx / (J * K));
      id.set(idx, coords.length); coords.push([i, j, k]);
    }
    const nbrs = coords.map(([i, j, k]) => {
      const l = [];
      for (const [a, b, c] of N26) {
        const ii = i + a, jj = j + b, kk = k + c;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= I || jj >= J || kk >= K) continue;
        const q = id.get((ii * J + jj) * K + kk); if (q !== undefined) l.push(q);
      }
      return l;
    });
    // like skan: within clusters of junction pixels (degree >= 3) keep only a minimum spanning tree
    const deg0 = nbrs.map(l => l.length);
    const jj = [];
    for (let u = 0; u < coords.length; u++) if (deg0[u] >= 3) for (const v of nbrs[u]) if (v > u && deg0[v] >= 3) {
      const a = coords[u], c = coords[v];
      jj.push([Math.hypot((c[0] - a[0]) * spacing[0], (c[1] - a[1]) * spacing[1], (c[2] - a[2]) * spacing[2]), u, v]);
    }
    if (jj.length) {
      jj.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
      const par = new Map(); const f = x => { while (par.has(x) && par.get(x) !== x) { const g = par.get(par.get(x)) ?? par.get(x); par.set(x, g); x = g; } return x; };
      const drop = new Set();
      for (const [, u, v] of jj) { const ru = f(u), rv = f(v); if (ru === rv) drop.add(u * 1e6 + v); else par.set(ru, rv); }
      if (drop.size) for (let u = 0; u < coords.length; u++) nbrs[u] = nbrs[u].filter(v => !drop.has(Math.min(u, v) * 1e6 + Math.max(u, v)));
    }
    const deg = nbrs.map(l => l.length);
    const isNode = deg.map(d => d !== 2);
    const used = new Set(); const key = (a, b) => (a < b ? a * 1e6 + b : b * 1e6 + a);
    const paths = [];
    const walk = (u, v) => {
      const path = [u, v]; used.add(key(u, v));
      let prev = u, cur = v;
      while (!isNode[cur]) {
        const nx = nbrs[cur][0] === prev ? nbrs[cur][1] : nbrs[cur][0];
        if (used.has(key(cur, nx))) break;
        used.add(key(cur, nx)); path.push(nx); prev = cur; cur = nx;
        if (cur === u) break;
      }
      return path;
    };
    for (let u = 0; u < coords.length; u++) {
      if (!isNode[u]) continue;
      for (const v of nbrs[u]) if (!used.has(key(u, v))) paths.push(walk(u, v));
    }
    for (let u = 0; u < coords.length; u++) { // isolated cycles
      if (isNode[u] || nbrs[u].some(v => used.has(key(u, v)))) continue;
      isNode[u] = true; paths.push(walk(u, nbrs[u][0]));
    }
    const sp = spacing;
    this.coords = coords; this.deg = deg; this.paths = paths;
    this.branches = paths.map((p, b) => {
      let dist = 0;
      for (let t = 1; t < p.length; t++) {
        const a = coords[p[t - 1]], c = coords[p[t]];
        dist += Math.hypot((c[0] - a[0]) * sp[0], (c[1] - a[1]) * sp[1], (c[2] - a[2]) * sp[2]);
      }
      const src = p[0], dst = p[p.length - 1];
      const ends = (deg[src] === 1) + (deg[dst] === 1);
      const type = src === dst ? 3 : ends === 2 ? 0 : ends === 1 ? 1 : 2;
      return { id: b, src, dst, dist, type };
    });
  }
  pathCoords(b) { return this.paths[b].map(q => this.coords[q]); }
  totalLength() { return this.branches.reduce((s, b) => s + b.dist, 0); }
}

function voxelIndex(c, shape) { return (c[0] * shape[1] + c[1]) * shape[2] + c[2]; }
function nbSum(sk, shape, c) {
  const [I, J, K] = shape; let s = 0;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
    const i = c[0] + a, j = c[1] + b, k = c[2] + d;
    if (i < 0 || j < 0 || k < 0 || i >= I || j >= J || k >= K) continue;
    s += sk[(i * J + j) * K + k];
  }
  return s;
}
function removeSmallSkel(sk, shape, minSize = 4) {
  const { labels, n } = label(sk, shape, 26); const s = counts(labels, n);
  const out = new Uint8Array(sk.length);
  for (let i = 0; i < sk.length; i++) out[i] = labels[i] && s[labels[i]] >= minSize ? 1 : 0;
  return out;
}

export function skeletonizePruned(mask, shape, spur = 4, iters = 3) {
  let sk = skeletonize(mask, shape);
  for (let it = 0; it < iters; it++) {
    if (!sk.some(v => v)) break;
    const G = new SkelGraph(sk, shape);
    const spurs = G.branches.filter(b => b.type === 1 && b.dist < spur);
    if (!spurs.length) break;
    for (const b of spurs) {
      const pts = G.pathCoords(b.id);
      for (const p of pts) sk[voxelIndex(p, shape)] = 0;
      for (const p of [pts[0], pts[pts.length - 1]]) if (nbSum(sk, shape, p) >= 2) sk[voxelIndex(p, shape)] = 1;
    }
    sk = skeletonize(sk, shape);
    sk = removeSmallSkel(sk, shape, 4);
  }
  return sk;
}

function dropStubsIn(sk, shape, region, iters = 3) {
  let removed = 0;
  for (let it = 0; it < iters; it++) {
    if (!sk.some(v => v)) break;
    const G = new SkelGraph(sk, shape); let hit = false;
    for (const b of G.branches) {
      if (b.type !== 1) continue;
      const p = G.pathCoords(b.id);
      const d0 = nbSum(sk, shape, p[0]) - 1;
      const tip = d0 === 1 ? p[0] : p[p.length - 1];
      let inb = 0; for (const q of p) inb += region[voxelIndex(q, shape)] ? 1 : 0;
      if (region[voxelIndex(tip, shape)] && inb / p.length >= 0.5) {
        for (let t = 1; t < p.length - 1; t++) sk[voxelIndex(p[t], shape)] = 0;
        sk[voxelIndex(tip, shape)] = 0; removed++; hit = true;
      }
    }
    if (!hit) break;
    sk = removeSmallSkel(sk, shape, 4);
  }
  return { sk, removed };
}

// ---- small graph helpers
class Heap { constructor() { this.a = []; } push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; } }
function dijkstra(adj, start, edgeOk) {
  const dist = new Map([[start, 0]]); const prev = new Map(); const h = new Heap(); h.push([0, start]);
  while (h.size) {
    const [d, u] = h.pop(); if (d > dist.get(u)) continue;
    for (const [v, w, eid] of adj.get(u) || []) {
      if (edgeOk && !edgeOk(eid)) continue;
      const nd = d + w;
      if (!dist.has(v) || nd < dist.get(v)) { dist.set(v, nd); prev.set(v, [u, eid]); h.push([nd, v]); }
    }
  }
  return { dist, prev };
}
function pathTo(prev, start, tgt) { const nodes = [tgt], edges = []; let c = tgt; while (c !== start) { const [p, e] = prev.get(c); nodes.push(p); edges.push(e); c = p; } return { nodes: nodes.reverse(), edges: edges.reverse() }; }

/** Split the skeleton into root axes by recursive longest path from the base. */
export function rootAxes(sk, shape, spacing) {
  const S = new SkelGraph(sk, shape, spacing);
  // node graph (one edge per node pair, shortest kept)
  const edgeMap = new Map();
  for (const b of S.branches) {
    if (b.src === b.dst) continue;
    const k = b.src < b.dst ? b.src * 1e6 + b.dst : b.dst * 1e6 + b.src;
    if (!edgeMap.has(k) || edgeMap.get(k).dist > b.dist) edgeMap.set(k, b);
  }
  const adj = new Map(); const addAdj = (u, v, w, e) => { if (!adj.has(u)) adj.set(u, []); adj.get(u).push([v, w, e]); };
  for (const b of edgeMap.values()) { addAdj(b.src, b.dst, b.dist, b.id); addAdj(b.dst, b.src, b.dist, b.id); }
  // components
  const comp = new Map(); const comps = [];
  for (const u of adj.keys()) {
    if (comp.has(u)) continue;
    const ci = comps.length; const nodes = [u]; comp.set(u, ci); let w = 0;
    for (let t = 0; t < nodes.length; t++) for (const [v, ww] of adj.get(nodes[t])) { w += ww / 2; if (!comp.has(v)) { comp.set(v, ci); nodes.push(v); } }
    comps.push({ nodes, w });
  }
  const order = comps.map((c, i) => i).sort((a, b) => comps[b].w - comps[a].w);
  const axes = []; let base0 = null;
  order.forEach((cidx, rank) => {
    const { nodes } = comps[cidx];
    let base = nodes[0]; for (const u of nodes) if (S.coords[u][2] > S.coords[base][2] || (S.coords[u][2] === S.coords[base][2] && u < base)) base = u;
    if (rank === 0) base0 = base;
    const { prev } = dijkstra(adj, base);
    const T = new Map(); const tadd = (u, v, w, e) => { if (!T.has(u)) T.set(u, []); T.get(u).push([v, w, e]); };
    for (const [v, [u, e]] of prev) { const w = S.branches[e].dist; tadd(u, v, w, e); tadd(v, u, w, e); }
    const used = new Set();
    const grow = (start, level, parent) => {
      if (!(T.get(start) || []).some(([, , e]) => !used.has(e))) return;
      const { dist, prev: pv } = dijkstra(T, start, e => !used.has(e));
      let tgt = start; for (const [v, d] of dist) if (d > dist.get(tgt)) tgt = v;
      if (dist.get(tgt) <= 0) return;
      const { nodes: path, edges } = pathTo(pv, start, tgt);
      edges.forEach(e => used.add(e));
      const me = axes.length + 1;
      axes.push({ id: me, component: rank, level, parent, length: dist.get(tgt), nodes: path, branches: edges });
      for (const nd of path) for (const [, , e] of T.get(nd) || []) if (!used.has(e)) grow(nd, level + 1, me);
    };
    grow(base, 0, null);
  });
  return { S, axes, base: base0, adj };
}

function axisPoints(S, ax) {
  let cur = S.coords[ax.nodes[0]]; const pts = [];
  for (const b of ax.branches) {
    let pc = S.pathCoords(b);
    const d0 = Math.hypot(pc[0][0] - cur[0], pc[0][1] - cur[1], pc[0][2] - cur[2]);
    const d1 = Math.hypot(pc[pc.length - 1][0] - cur[0], pc[pc.length - 1][1] - cur[1], pc[pc.length - 1][2] - cur[2]);
    if (d0 > d1) pc = pc.slice().reverse();
    pts.push(...(pts.length ? pc.slice(1) : pc));
    cur = pc[pc.length - 1];
  }
  return pts;
}

// ===================================================================== main pipeline
/**
 * analyze(vol, params, edits, cache, log)
 * vol    : {data: Float32Array, shape:[I,J,K]} oriented (k vertical, base high)
 * edits  : {points: [[[i,j,k], 'root'|'nonroot'], ...], spheres: [{c:[i,j,k], r, mode:'erase'|'add'}]}
 * cache  : object reused between calls (normalised image, Hessian maps)
 */
export function analyze(vol, params = {}, edits = {}, cache = {}, log = () => {}) {
  const p = { ...DEFAULTS, ...params };
  const { shape } = vol; const [I, J, K] = shape; const N = I * J * K;
  const sp = p.voxel.map(Number);
  const pts = (edits.points || []).map(([q, a]) => [q.map(Math.round), a]);
  const at = q => voxelIndex(q, shape);
  // paint volume from spheres: 1 erase, 2 add
  let paint = null;
  if (edits.spheres && edits.spheres.length) {
    paint = new Uint8Array(N);
    for (const s of edits.spheres) {
      const r = s.r, [ci, cj, ck] = s.c;
      for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(I - 1, Math.ceil(ci + r)); i++)
        for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(J - 1, Math.ceil(cj + r)); j++)
          for (let k = Math.max(0, Math.floor(ck - r)); k <= Math.min(K - 1, Math.ceil(ck + r)); k++)
            if ((i - ci) ** 2 + (j - cj) ** 2 + (k - ck) ** 2 <= r * r) paint[(i * J + j) * K + k] = s.mode === 'erase' ? 1 : 2;
    }
  }
  if (cache.zSigma !== p.sigma || cache.zN !== N) {
    log('Normalising image…');
    for (const k of Object.keys(cache)) delete cache[k];
    cache.z = normalise(vol, p.sigma); cache.zSigma = p.sigma; cache.zN = N;
  }
  const z = cache.z;
  log('Detecting roots…');
  const m = hysteresis(z, p.lo, p.hi, shape);
  if (paint) for (let i = 0; i < N; i++) if (paint[i] === 2) m[i] = 1;
  const { labels: cand, n: nc } = label(m, shape, 26);
  const sz = counts(cand, nc);
  if (!nc) throw new Error('Nothing above threshold — lower the thresholds.');
  const order = Array.from({ length: nc }, (_, i) => i + 1).sort((a, b) => sz[b] - sz[a] || a - b);
  const main = order[0];
  const cls = new Uint8Array(nc + 1); cls[main] = 1;
  order.slice(1, 1 + p.n_markers).forEach(i => { cls[i] = 2; });
  const feat = new Uint8Array(N); for (let i = 0; i < N; i++) feat[i] = cand[i] === main ? 1 : 0;
  const d2 = edt2(feat, shape);
  const minD = new Float64Array(nc + 1).fill(Infinity);
  for (let i = 0; i < N; i++) if (cand[i] && d2[i] < minD[cand[i]]) minD[cand[i]] = d2[i];
  for (const i of order.slice(1 + p.n_markers)) {
    if (cls[i]) continue;
    cls[i] = sz[i] >= p.min_frag ? (Math.sqrt(minD[i]) <= p.frag_dist ? 1 : 3) : 3;
  }
  for (const [q, a] of pts) {
    const cid = cand[at(q)];
    if (!cid || cid === main) continue;
    cls[cid] = a === 'root' ? 1 : 4;
  }
  const clsVol = new Uint8Array(N); for (let i = 0; i < N; i++) clsVol[i] = cls[cand[i]];
  let keep = new Uint8Array(N); for (let i = 0; i < N; i++) keep[i] = clsVol[i] === 1 ? 1 : 0;
  keep = closingBall1(keep, shape);
  keep = fillHoles(keep, shape);
  if (paint) for (let i = 0; i < N; i++) { if (paint[i] === 1) keep[i] = 0; if (paint[i] === 2) keep[i] = 1; }

  // ---- water blobs
  let blobs = new Int32Array(N); const blobInfo = [];
  const forced = new Uint8Array(N);
  if (p.water_filter) {
    let lo = [I, J, K], hi = [0, 0, 0];
    shiftLoop(shape, (i, j, k, idx) => { if (keep[idx]) { lo = [Math.min(lo[0], i), Math.min(lo[1], j), Math.min(lo[2], k)]; hi = [Math.max(hi[0], i), Math.max(hi[1], j), Math.max(hi[2], k)]; } });
    lo = lo.map(v => Math.max(v - 10, 0)); hi = hi.map((v, a) => Math.min(v + 11, shape[a]));
    const hb = cache.hessBox;
    if (!hb || lo.some((v, a) => v < hb[0][a]) || hi.some((v, a) => v > hb[1][a])) {
      lo = lo.map(v => Math.max(v - 8, 0)); hi = hi.map((v, a) => Math.min(v + 8, shape[a]));
      log('Computing tube/blob shape maps (once per scan)…');
      const cs = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const sub = new Float32Array(cs[0] * cs[1] * cs[2]);
      for (let i = 0; i < cs[0]; i++) for (let j = 0; j < cs[1]; j++) for (let k = 0; k < cs[2]; k++)
        sub[(i * cs[1] + j) * cs[2] + k] = z[((i + lo[0]) * J + j + lo[1]) * K + k + lo[2]];
      const { B: bb, T: tt } = hessianShape(sub, cs, undefined, 40, log);
      const Bf = new Float32Array(N), Tf = new Float32Array(N);
      for (let i = 0; i < cs[0]; i++) for (let j = 0; j < cs[1]; j++) for (let k = 0; k < cs[2]; k++) {
        const s = (i * cs[1] + j) * cs[2] + k, d = ((i + lo[0]) * J + j + lo[1]) * K + k + lo[2];
        Bf[d] = bb[s]; Tf[d] = tt[s];
      }
      cache.hessBox = [lo, hi]; cache.B = Bf; cache.T = Tf;
    }
    const core = new Uint8Array(N);
    for (let i = 0; i < N; i++) core[i] = keep[i] && cache.B[i] / (cache.T[i] + 1e-6) > p.blob_ratio && cache.B[i] > 1.0 ? 1 : 0;
    const { labels: cl, n: ncl } = label(core, shape, 26); const cs2 = counts(cl, ncl);
    let region = new Uint8Array(N); for (let i = 0; i < N; i++) region[i] = cl[i] && cs2[cl[i]] >= p.min_blob ? 1 : 0;
    region = dilate(region, shape, 26, 1); for (let i = 0; i < N; i++) region[i] &= keep[i];
    blobs = label(region, shape, 26).labels;
    for (const [q, a] of pts) {
      const b = blobs[at(q)];
      if (b && a === 'nonroot') for (let i = 0; i < N; i++) if (blobs[i] === b) forced[i] = 1;
    }
    for (let i = 0; i < N; i++) if (forced[i]) { keep[i] = 0; clsVol[i] = 5; }
  }
  log('Skeletonising…');
  let sk = skeletonizePruned(keep, shape, p.spur);
  if (!sk.some(v => v)) throw new Error('Skeleton is empty — lower the thresholds.');
  let top = null; shiftLoop(shape, (i, j, k, idx) => { if (sk[idx] && (!top || k > top[2])) top = [i, j, k]; });
  const maskVol = Uint8Array.from(keep);
  let nStubs = 0;
  const nBlobs = blobs.reduce((a, b) => Math.max(a, b), 0);
  if (p.water_filter && nBlobs) {
    const active = new Uint8Array(N); const status = new Map();
    const members = Array.from({ length: nBlobs + 1 }, () => []);
    for (let i = 0; i < N; i++) if (blobs[i]) members[blobs[i]].push(i);
    for (let b = 1; b <= nBlobs; b++) {
      const mem = members[b]; if (!mem.length) continue;
      const c = [0, 0, 0]; for (const idx of mem) { const k = idx % K, j = ((idx - k) / K) % J, i = Math.floor(idx / (J * K)); c[0] += i; c[1] += j; c[2] += k; }
      c.forEach((v, a) => { c[a] = v / mem.length; });
      let st = null;
      if (mem.some(i => forced[i])) st = 'removed by you';
      else if (pts.some(([q, a]) => blobs[at(q)] === b && a === 'root')) st = 'kept as root by you';
      else if (Math.hypot(c[0] - top[0], c[1] - top[1], c[2] - top[2]) <= p.crown_protect) st = 'kept (plant base / crown)';
      else mem.forEach(i => { active[i] = 1; });
      status.set(b, [st, c, mem.length]);
    }
    const r = dropStubsIn(sk, shape, active); sk = r.sk; nStubs = r.removed;
    const tube = dilate(sk, shape, 6, 1);
    for (const [b, [st0, c, n]] of status) {
      let st = st0, rem = 0; const mem = members[b];
      if (st === null) {
        const through = mem.some(i => sk[i]);
        st = through ? 'root passes through: thinned' : 'water pocket: removed';
        let newN = 0; for (const i of mem) { maskVol[i] = tube[i] ? 1 : 0; newN += tube[i]; }
        rem = n - newN;
      } else if (st === 'removed by you') rem = n;
      blobInfo.push({ id: b, center_voxel: c.map(Math.round), voxels: n, removed_voxels: rem, action: st });
    }
    for (const bi of blobInfo) if (bi.action.startsWith('kept')) for (const i of members[bi.id]) blobs[i] = 0;
  }

  // ---- axes and traits
  log('Tracing roots…');
  const { S, axes, base, adj } = rootAxes(sk, shape, sp);
  const baseXYZ = S.coords[base];
  const spMean = (sp[0] + sp[1] + sp[2]) / 3;
  for (const ax of axes) {
    const st = S.coords[ax.nodes[0]];
    ax.start_dist_vox = Math.hypot(st[0] - baseXYZ[0], st[1] - baseXYZ[1], st[2] - baseXYZ[2]);
    const lv = ax.length / spMean;
    ax.type = ax.component !== 0 ? 'fragment' : (ax.start_dist_vox <= p.crown && lv >= p.min_main) ? 'main' : lv >= p.min_lat ? 'lateral' : 'minor';
    ax.pts = axisPoints(S, ax);
  }
  const skLab = new Int32Array(N);
  for (const ax of axes.slice().sort((a, b) => a.length - b.length)) for (const q of ax.pts) skLab[at(q)] = ax.id;
  const tips = [], branchPts = [];
  for (const [u, l] of adj) { if (l.length === 1 && u !== base) tips.push(S.coords[u]); if (l.length >= 3) branchPts.push(S.coords[u]); }
  const total = S.totalLength();
  let kmin = K, nVol = 0; let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
  shiftLoop(shape, (i, j, k, idx) => {
    if (keep[idx] && k < kmin) kmin = k;
    if (maskVol[idx]) { nVol++; mn = [Math.min(mn[0], i), Math.min(mn[1], j)]; mx = [Math.max(mx[0], i), Math.max(mx[1], j)]; }
  });
  const depthVox = baseXYZ[2] - kmin;
  const vv = sp[0] * sp[1] * sp[2];
  const traits = {
    voxel_size_mm: sp,
    total_root_length_mm: total,
    n_main_roots: axes.filter(a => a.type === 'main').length,
    n_lateral_roots: axes.filter(a => a.type === 'lateral').length,
    n_fragments: axes.filter(a => a.type === 'fragment').length,
    n_root_tips: tips.length,
    n_branch_points: branchPts.length,
    main_root_length_mm: axes.filter(a => a.type === 'main').reduce((s, a) => s + a.length, 0),
    lateral_root_length_mm: axes.filter(a => a.type === 'lateral').reduce((s, a) => s + a.length, 0),
    longest_root_mm: Math.max(...axes.map(a => a.length)),
    rooting_depth_mm: depthVox * sp[2],
    max_lateral_spread_mm: Math.max((mx[0] - mn[0]) * sp[0], (mx[1] - mn[1]) * sp[1]),
    root_volume_mm3: nVol * vv,
    mean_diameter_est_mm: 2 * Math.sqrt(nVol * vv / (Math.PI * total)),
    n_water_blobs: blobInfo.length,
    water_volume_removed_mm3: blobInfo.reduce((s, b) => s + b.removed_voxels, 0) * vv,
    water_stub_branches_removed: nStubs,
    base_voxel: baseXYZ,
  };
  const nb = Math.floor(depthVox / 10) + 1;
  const prof = new Float64Array(Math.max(nb, 1));
  for (let b = 0; b < S.branches.length; b++) {
    const pc = S.pathCoords(b);
    for (let t = 1; t < pc.length; t++) {
      const a = pc[t - 1], c = pc[t];
      const seg = Math.hypot((c[0] - a[0]) * sp[0], (c[1] - a[1]) * sp[1], (c[2] - a[2]) * sp[2]);
      const d = baseXYZ[2] - (a[2] + c[2]) / 2;
      prof[Math.min(Math.max(Math.floor(d / 10), 0), prof.length - 1)] += seg;
    }
  }
  traits.length_by_depth = { bin_top_mm: Array.from(prof, (_, i) => i * 10 * sp[2]), length_mm: Array.from(prof, v => Math.round(v * 100) / 100) };
  const roots = axes.filter(a => a.type !== 'minor').sort((a, b) => b.length - a.length).map(a => {
    const s = a.pts[0], t = a.pts[a.pts.length - 1];
    return { root_id: a.id, type: a.type, parent_id: a.parent ?? '', length_mm: +a.length.toFixed(2),
      tip_depth_mm: +((baseXYZ[2] - t[2]) * sp[2]).toFixed(2), start_voxel: s.join(' '), tip_voxel: t.join(' ') };
  });
  return { params: p, shape, cand, clsVol, mask: keep, maskVol, blobs, blobInfo, sk, skLab,
    axes: axes.map(({ nodes, branches, ...rest }) => rest), tips, branchPts, traits, roots };
}

// ===================================================================== surface mesh (naive surface nets)
/** Smooth a binary mask and extract an iso-surface. Returns {pos: Float32Array (voxel coords), idx: Uint32Array}. */
export function surfaceMesh(mask, shape, level = 0.4, sigma = 0.8) {
  const [I, J, K] = shape;
  let lo = [I, J, K], hi = [-1, -1, -1];
  shiftLoop(shape, (i, j, k, idx) => { if (mask[idx]) { lo = [Math.min(lo[0], i), Math.min(lo[1], j), Math.min(lo[2], k)]; hi = [Math.max(hi[0], i), Math.max(hi[1], j), Math.max(hi[2], k)]; } });
  if (hi[0] < 0) return { pos: new Float32Array(0), idx: new Uint32Array(0) };
  const pad = 4; lo = lo.map(v => v - pad); hi = hi.map(v => v + pad);
  const cs = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  const f = new Float32Array(cs[0] * cs[1] * cs[2]);
  for (let i = 0; i < cs[0]; i++) for (let j = 0; j < cs[1]; j++) for (let k = 0; k < cs[2]; k++) {
    const gi = i + lo[0], gj = j + lo[1], gk = k + lo[2];
    if (gi < 0 || gj < 0 || gk < 0 || gi >= I || gj >= J || gk >= K) continue;
    f[(i * cs[1] + j) * cs[2] + k] = mask[(gi * J + gj) * K + gk];
  }
  const g = gaussian3d(f, cs, sigma, [0, 0, 0], 'constant', 4);
  const [X, Y, Z] = cs; const val = (i, j, k) => g[(i * Y + j) * Z + k] - level;
  const vid = new Int32Array(X * Y * Z).fill(-1); const pos = []; const idx = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let i = 0; i < X - 1; i++) for (let j = 0; j < Y - 1; j++) for (let k = 0; k < Z - 1; k++) {
    const v = corners.map(([a, b, c]) => val(i + a, j + b, k + c));
    let inside = 0; for (const x of v) if (x > 0) inside++;
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      if ((v[a] > 0) === (v[b] > 0)) continue;
      const t = v[a] / (v[a] - v[b]); const ca = corners[a], cb = corners[b];
      sx += ca[0] + t * (cb[0] - ca[0]); sy += ca[1] + t * (cb[1] - ca[1]); sz += ca[2] + t * (cb[2] - ca[2]); n++;
    }
    vid[(i * Y + j) * Z + k] = pos.length / 3;
    pos.push(i + sx / n + lo[0], j + sy / n + lo[1], k + sz / n + lo[2]);
  }
  const cell = (i, j, k) => vid[(i * Y + j) * Z + k];
  for (let i = 1; i < X - 1; i++) for (let j = 1; j < Y - 1; j++) for (let k = 1; k < Z - 1; k++) {
    const a = val(i, j, k) > 0;
    // edge along each axis from (i,j,k) to +1; quad from the 4 cells sharing it
    const tests = [[[1, 0, 0], [[0, 0, 0], [0, -1, 0], [0, -1, -1], [0, 0, -1]]],
      [[0, 1, 0], [[0, 0, 0], [0, 0, -1], [-1, 0, -1], [-1, 0, 0]]],
      [[0, 0, 1], [[0, 0, 0], [-1, 0, 0], [-1, -1, 0], [0, -1, 0]]]];
    for (const [[da, db, dc], q] of tests) {
      if (i + da >= X || j + db >= Y || k + dc >= Z) continue;
      const b = val(i + da, j + db, k + dc) > 0;
      if (a === b) continue;
      const vs = q.map(([x, y, w]) => cell(i + x, j + y, k + w));
      if (vs.some(v => v < 0)) continue;
      if (a) idx.push(vs[0], vs[1], vs[2], vs[0], vs[2], vs[3]); else idx.push(vs[0], vs[2], vs[1], vs[0], vs[3], vs[2]);
    }
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

// ===================================================================== exports
export function scalarTraits(t) { const o = {}; for (const [k, v] of Object.entries(t)) if (typeof v !== 'object') o[k] = v; return o; }

export function traitsCSV(runs) { // runs: [[name, result]]
  const keys = []; for (const [, r] of runs) for (const k of Object.keys(scalarTraits(r.traits))) if (!keys.includes(k)) keys.push(k);
  const pk = ['lo', 'hi', 'sigma', 'water_filter', 'blob_ratio', 'n_markers', 'min_frag', 'frag_dist'];
  const fmt = v => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : v ?? '');
  const lines = [['run', ...keys, ...pk.map(k => 'param_' + k)].join(',')];
  for (const [name, r] of runs) lines.push([`"${name.replace(/"/g, "'")}"`, ...keys.map(k => fmt(r.traits[k])), ...pk.map(k => r.params[k])].join(','));
  return lines.join('\n') + '\n';
}

export function rootsCSV(result) {
  const rows = result.roots; if (!rows.length) return 'root_id\n';
  const keys = Object.keys(rows[0]);
  return [keys.join(','), ...rows.map(r => keys.map(k => r[k]).join(','))].join('\n') + '\n';
}

export function rsml(result, name = 'scan') {
  const sp = result.params.voxel;
  const axes = new Map(result.axes.filter(a => a.type !== 'minor').map(a => [a.id, a]));
  const all = new Map(result.axes.map(a => [a.id, a]));
  const children = new Map();
  const top = [];
  for (const a of axes.values()) {
    let par = a.parent; while (par && !axes.has(par)) par = all.get(par)?.parent ?? null;
    if (par && a.type !== 'main') { if (!children.has(par)) children.set(par, []); children.get(par).push(a); } else top.push(a);
  }
  const write = (a, ind) => {
    const pad = ' '.repeat(ind);
    let s = `${pad}<root id="r${a.id}" label="${a.type}">\n${pad}  <geometry>\n${pad}    <polyline>\n`;
    for (const q of a.pts) s += `${pad}      <point x="${(q[0] * sp[0]).toFixed(2)}" y="${(q[1] * sp[1]).toFixed(2)}" z="${(q[2] * sp[2]).toFixed(2)}"/>\n`;
    s += `${pad}    </polyline>\n${pad}  </geometry>\n`;
    for (const c of children.get(a.id) || []) s += write(c, ind + 2);
    return s + `${pad}</root>\n`;
  };
  let s = `<?xml version="1.0" encoding="utf-8"?>\n<rsml>\n  <metadata>\n    <version>1</version>\n    <unit>mm</unit>\n    <resolution>1</resolution>\n    <software>Root Viewer (web)</software>\n    <file-key>${name}</file-key>\n  </metadata>\n  <scene>\n    <plant id="1" label="wheat">\n`;
  for (const a of top.sort((x, y) => x.level - y.level)) s += write(a, 6);
  return s + '    </plant>\n  </scene>\n</rsml>\n';
}

/** Write MATLAB v5 .mat (each variable zlib-compressed). vars: [{name, data(TypedArray C-order), shape, cls}] */
export async function writeMat(vars) {
  const enc = new TextEncoder();
  const header = new Uint8Array(128).fill(32);
  header.set(enc.encode('MATLAB 5.0 MAT-file, created by Root Viewer (web)').slice(0, 116));
  header.fill(0, 116, 124); header[124] = 0; header[125] = 1; header[126] = 0x49; header[127] = 0x4d;
  const parts = [header];
  const clsInfo = { uint8: [9, 2, 1, Uint8Array], int16: [10, 3, 2, Int16Array], int32: [12, 5, 4, Int32Array], double: [6, 9, 8, Float64Array] };
  for (const v of vars) {
    const [mxc, mit, bytes, Ctor] = clsInfo[v.cls];
    const shape = v.shape; const n = shape.reduce((a, b) => a * b, 1);
    const colmaj = new Ctor(n);
    if (shape.length === 3) {
      const [I, J, K] = shape;
      for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) for (let k = 0; k < K; k++) colmaj[i + I * (j + J * k)] = v.data[(i * J + j) * K + k];
    } else { const [R, C] = shape; for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) colmaj[r + R * c] = v.data[r * C + c]; }
    const pad8 = x => Math.ceil(x / 8) * 8;
    const nameB = enc.encode(v.name);
    const dataB = new Uint8Array(colmaj.buffer);
    const sub = 16 + (8 + pad8(shape.length * 4)) + (8 + pad8(nameB.length)) + (8 + pad8(dataB.length));
    const el = new Uint8Array(8 + sub); const dv = new DataView(el.buffer);
    let o = 0; const u32 = x => { dv.setUint32(o, x, true); o += 4; };
    u32(14); u32(sub);
    u32(6); u32(8); u32(mxc); u32(0);
    u32(5); u32(shape.length * 4); for (const s of shape) { dv.setInt32(o, s, true); o += 4; } o = pad8(o);
    u32(1); u32(nameB.length); el.set(nameB, o); o += pad8(nameB.length);
    u32(mit); u32(dataB.length); el.set(dataB, o);
    const cs = new Blob([el]).stream().pipeThrough(new CompressionStream('deflate'));
    const comp = new Uint8Array(await new Response(cs).arrayBuffer());
    const tag = new Uint8Array(8); const tv = new DataView(tag.buffer); tv.setUint32(0, 15, true); tv.setUint32(4, comp.length, true);
    parts.push(tag, comp);
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/** Minimal ZIP (store, no compression). files: [{name, data: Uint8Array|string}] */
export function makeZip(files) {
  const enc = new TextEncoder();
  const crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc32 = d => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = crcT[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name); const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, x) => s + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
