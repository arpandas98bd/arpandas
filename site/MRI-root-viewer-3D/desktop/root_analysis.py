"""
root_analysis.py — root system analysis for 3D MRI volumes (.mat)

Used two ways:
  1. As the engine behind root_viewer.py (interactive app)
  2. From the command line:
       python root_analysis.py scan.mat --voxel 2 2 2 --out results/scan1
       python root_analysis.py scan.mat --voxel 2 2 2 --lo 2.5 --hi 5 --no-water-filter

Internal convention: after orient(), array axis 2 is vertical and the plant base is
at the HIGH index end. Use --vertical-axis / --base-low if your scans differ.

Requires: numpy scipy scikit-image skan networkx (+ plotly for the HTML export,
tifffile for TIFF export, h5py for v7.3 .mat files)
"""
import argparse, csv, json, os
import xml.etree.ElementTree as ET
import numpy as np
import scipy.io as sio
from scipy import ndimage as ndi
from skimage import filters, morphology, measure
from skan import Skeleton, summarize
import networkx as nx

DEFAULTS = dict(
    voxel=(2.0, 2.0, 2.0),   # mm per voxel along (internal) axes 0,1,2
    sigma=0.7,               # smoothing before thresholding (voxels)
    lo=3.0, hi=6.0,          # hysteresis thresholds in noise SDs
    n_markers=2,             # bright detached blobs to treat as reference markers
    min_frag=40,             # min voxels of a detached piece to keep
    frag_dist=8,             # max gap (voxels) between a detached piece and the roots
    water_filter=True,
    blob_ratio=1.0,          # sphere-vs-tube ratio above which a region is a blob (higher = stricter)
    min_blob=20,             # min blob core size (voxels)
    crown_protect=10,        # blobs within this many voxels of the base are left alone
    crown=20,                # axes starting within this radius of the base = main roots
    min_main=20, min_lat=5,  # min lengths (voxels) of main / lateral roots
    spur=4,                  # prune skeleton spurs shorter than this (voxels)
)
CLASS_NAMES = {1: 'root', 2: 'marker', 3: 'detached noise', 4: 'excluded by you', 5: 'water blob'}


# ----------------------------------------------------------------- I/O
def list_mat_vars(path):
    try:
        return [(k, v.shape) for k, v in sio.loadmat(path).items()
                if not k.startswith('__') and isinstance(v, np.ndarray) and v.ndim == 3]
    except NotImplementedError:
        import h5py
        out = []
        with h5py.File(path) as f:
            f.visititems(lambda n, o: out.append((n, o.shape[::-1])) if hasattr(o, 'shape') and len(o.shape) == 3 else None)
        return out


def load(path, var=None):
    vars_ = list_mat_vars(path)
    if not vars_:
        raise ValueError('No 3D array found in ' + path)
    var = var or ('im' if any(v[0] == 'im' for v in vars_) else max(vars_, key=lambda v: np.prod(v[1]))[0])
    try:
        im = sio.loadmat(path)[var]
    except NotImplementedError:
        import h5py
        with h5py.File(path) as f:
            im = np.asarray(f[var]).T
    im = np.asarray(im)
    if np.iscomplexobj(im):
        im = np.abs(im)
    return im.astype(np.float64), var


def orient(im, vertical_axis=2, base_high=True):
    """Return a view with the vertical axis last and the plant base at the high index."""
    order = [a for a in range(3) if a != vertical_axis] + [vertical_axis]
    im = np.transpose(im, order)
    return im if base_high else im[:, :, ::-1]


# ----------------------------------------------------------------- steps
def normalise(im, sigma):
    sm = ndi.gaussian_filter(im, sigma)
    med = np.median(sm, axis=(0, 1), keepdims=True)
    mad = np.median(np.abs(sm - med), axis=(0, 1), keepdims=True) * 1.4826
    return ((sm - med) / np.maximum(mad, 1e-12)).astype(np.float32)


def hessian_shape(z, sigmas=(1.0, 1.5, 2.0, 3.0), clip=40):
    """Multi-scale Hessian blob-ness and tube-ness for bright structures."""
    from skimage.feature import hessian_matrix, hessian_matrix_eigvals
    zc = np.clip(z, 0, clip).astype(np.float64)
    B, T = [], []
    for s in sigmas:
        H = hessian_matrix(zc, sigma=s, order='rc', use_gaussian_derivatives=True)
        ev = np.stack(hessian_matrix_eigvals(H))
        ev = np.take_along_axis(ev, np.argsort(np.abs(ev), axis=0), 0)
        l1, l2, l3 = ev
        bright = (l2 < 0) & (l3 < 0)
        Rb = np.abs(l1) / np.sqrt(np.abs(l2 * l3) + 1e-9)
        Ra = np.abs(l2) / (np.abs(l3) + 1e-9)
        S = np.sqrt(l1**2 + l2**2 + l3**2) * s**2
        B.append(np.where(bright & (l1 < 0), S * Rb, 0))
        T.append(np.where(bright, S * Ra * (1 - Rb), 0))
    return np.max(B, 0).astype(np.float32), np.max(T, 0).astype(np.float32)


def skeletonize(mask, spur=4, iters=3):
    sk = morphology.skeletonize(mask)
    for _ in range(iters):
        if not sk.any():
            break
        S = Skeleton(sk); df = summarize(S, separator='_')
        spurs = df[(df.branch_type == 1) & (df.branch_distance < spur)]
        if len(spurs) == 0:
            break
        for bi in spurs.index:
            pts = S.path_coordinates(bi).astype(int)
            for p in pts:
                sk[tuple(p)] = False
            for p in (pts[0], pts[-1]):
                q = tuple(p)
                nb = sk[max(q[0]-1, 0):q[0]+2, max(q[1]-1, 0):q[1]+2, max(q[2]-1, 0):q[2]+2].sum()
                if nb >= 2:
                    sk[q] = True
        sk = morphology.skeletonize(sk)
        lab, _ = ndi.label(sk, np.ones((3, 3, 3)))
        s2 = np.bincount(lab.ravel()); s2[0] = 0
        sk = np.isin(lab, np.where(s2 >= 4)[0])
    return sk


def drop_stubs_in(sk, region, iters=3):
    """Delete skeleton end-branches whose free end lies inside `region`."""
    removed = 0
    for _ in range(iters):
        if not sk.any():
            break
        S = Skeleton(sk); df = summarize(S, separator='_')
        hit = False
        for bi, r in df.iterrows():
            if r.branch_type != 1:
                continue
            p = S.path_coordinates(bi).astype(int)
            q = p[0]
            d0 = sk[max(q[0]-1, 0):q[0]+2, max(q[1]-1, 0):q[1]+2, max(q[2]-1, 0):q[2]+2].sum() - 1
            tip = p[0] if d0 == 1 else p[-1]
            if region[tuple(tip)] and region[tuple(p.T)].mean() >= 0.5:
                sk[tuple(p[1:-1].T)] = False
                sk[tuple(tip)] = False
                removed += 1; hit = True
        if not hit:
            break
        lab, _ = ndi.label(sk, np.ones((3, 3, 3)))
        s2 = np.bincount(lab.ravel()); s2[0] = 0
        sk = np.isin(lab, np.where(s2 >= 4)[0])
    return sk, removed


def root_axes(sk, spacing):
    """Split the skeleton into root axes by recursive longest path from the base.
    Each axis: id, component, level, parent, length, nodes, branches."""
    S = Skeleton(sk, spacing=spacing)
    df = summarize(S, separator='_')
    coords = S.coordinates
    G = nx.Graph()
    for i, r in df.iterrows():
        a, b = int(r.node_id_src), int(r.node_id_dst)
        if a != b:
            G.add_edge(a, b, w=float(r.branch_distance), bi=int(i))
    comps = sorted(nx.connected_components(G), key=lambda c: -G.subgraph(c).size(weight='w'))
    axes, base0 = [], None
    for ci, c in enumerate(comps):
        H = G.subgraph(c)
        base = max(c, key=lambda k: coords[k][2])
        if ci == 0:
            base0 = base
        _, paths = nx.single_source_dijkstra(H, base, weight='w')
        T = nx.Graph()
        for p in paths.values():
            for a, b in zip(p[:-1], p[1:]):
                T.add_edge(a, b, **H.edges[a, b])
        used = set()

        def grow(start, level, parent):
            free = T.edge_subgraph([e for e in T.edges if frozenset(e) not in used])
            if start not in free:
                return
            dd, pp = nx.single_source_dijkstra(free, start, weight='w')
            tgt = max(dd, key=dd.get)
            if dd[tgt] <= 0:
                return
            path = pp[tgt]
            for a, b in zip(path[:-1], path[1:]):
                used.add(frozenset((a, b)))
            me = len(axes)
            axes.append(dict(id=me + 1, component=ci, level=level, parent=parent, length=dd[tgt],
                             nodes=path, branches=[T.edges[a, b]['bi'] for a, b in zip(path[:-1], path[1:])]))
            for nd in path:
                for nb in list(T.neighbors(nd)):
                    if frozenset((nd, nb)) not in used:
                        grow(nd, level + 1, me + 1)
        grow(base, 0, None)
    return S, df, coords, G, axes, base0


def axis_points(S, ax, coords):
    """Ordered voxel coordinates along an axis (base end first)."""
    cur = np.asarray(coords[ax['nodes'][0]], float)
    pts = []
    for b in ax['branches']:
        pc = S.path_coordinates(b)
        if np.linalg.norm(pc[0] - cur) > np.linalg.norm(pc[-1] - cur):
            pc = pc[::-1]
        pts.extend(pc.tolist() if not pts else pc[1:].tolist())
        cur = pc[-1]
    return np.array(pts).reshape(-1, 3)


# ----------------------------------------------------------------- main pipeline
def analyze(im, params=None, edits=None, cache=None, log=print):
    """Run the full pipeline.

    im      : oriented 3D array (axis 2 vertical, base at high index)
    params  : dict, see DEFAULTS
    edits   : dict(points=[((i,j,k), 'root'|'nonroot'), ...], paint=int array or None)
              'nonroot' on a detached object excludes it; on a water blob removes it fully.
              'root' on an excluded object brings it back; on a water blob keeps it as root.
              paint: 1 = erase voxels from roots, 2 = add voxels to roots.
    cache   : optional dict reused between calls (normalised image, Hessian maps)
    Returns a dict with every layer, the traits and the per-root table.
    """
    p = dict(DEFAULTS, **(params or {}))
    edits = edits or {}
    pts_edit = [(tuple(int(round(c)) for c in q), a) for q, a in edits.get('points', [])]
    paint = edits.get('paint')
    sp = np.array(p['voxel'], float)
    msgs = []

    cache = {} if cache is None else cache
    if cache.get('z_sigma') != p['sigma'] or cache.get('z_shape') != im.shape:
        log('Normalising image…')
        cache.clear()
        cache.update(z=normalise(im, p['sigma']), z_sigma=p['sigma'], z_shape=im.shape)
    z = cache['z']
    m = filters.apply_hysteresis_threshold(z, p['lo'], p['hi'])
    if paint is not None:
        m = m | (paint == 2)
    cand, _ = ndi.label(m, structure=np.ones((3, 3, 3)))
    sz = np.bincount(cand.ravel()); sz[0] = 0
    if sz.max() == 0:
        raise ValueError('Nothing above threshold — lower the thresholds.')
    order = np.argsort(sz)[::-1]
    order = order[sz[order] > 0]
    main = order[0]
    cls = np.zeros(len(sz), np.uint8)
    cls[main] = 1
    for i in order[1:1 + p['n_markers']]:
        cls[i] = 2
    dist = ndi.distance_transform_edt(cand != main)
    objs = ndi.find_objects(cand)
    for i in order[1 + p['n_markers']:]:
        if cls[i]:
            continue
        if sz[i] >= p['min_frag']:
            sl = objs[i - 1]
            cls[i] = 1 if dist[sl][cand[sl] == i].min() <= p['frag_dist'] else 3
        else:
            cls[i] = 3
    for q, a in pts_edit:
        cid = cand[q]
        if cid == 0 or cid == main:
            continue
        cls[cid] = 1 if a == 'root' else 4
    cls_vol = cls[cand]  # class per voxel (0 = background)

    keep = cls_vol == 1
    keep = morphology.closing(keep, morphology.ball(1))
    keep = ndi.binary_fill_holes(keep)
    if paint is not None:
        keep &= paint != 1
        keep |= paint == 2

    # water blobs ---------------------------------------------------
    blobs = np.zeros(keep.shape, np.int32)
    blob_info = []
    forced_remove = np.zeros(keep.shape, bool)
    if p['water_filter']:
        # Hessian maps only around the roots, cached; recomputed if roots grow outside the box
        pts = np.argwhere(keep)
        lo_c = np.maximum(pts.min(0) - 10, 0); hi_c = np.minimum(pts.max(0) + 11, keep.shape)
        hb = cache.get('hess_box')
        if hb is None or np.any(lo_c < hb[0]) or np.any(hi_c > hb[1]):
            lo_c = np.maximum(lo_c - 8, 0); hi_c = np.minimum(hi_c + 8, keep.shape)
            log('Computing tube/blob shape maps (once per image, ~10–30 s)…')
            sl = tuple(slice(a, b) for a, b in zip(lo_c, hi_c))
            bb, tt = hessian_shape(z[sl])
            bness = np.zeros(z.shape, np.float32); tness = np.zeros(z.shape, np.float32)
            bness[sl] = bb; tness[sl] = tt
            cache.update(hess_box=(lo_c, hi_c), bness=bness, tness=tness)
        bness, tness = cache['bness'], cache['tness']
        core = (bness / (tness + 1e-6) > p['blob_ratio']) & (bness > 1.0) & keep
        lab, _ = ndi.label(core, np.ones((3, 3, 3)))
        s = np.bincount(lab.ravel()); s[0] = 0
        region = np.isin(lab, np.where(s >= p['min_blob'])[0])
        region = ndi.binary_dilation(region, np.ones((3, 3, 3))) & keep
        blobs, nb = ndi.label(region, np.ones((3, 3, 3)))
        for q, a in pts_edit:
            if blobs[q] and a == 'nonroot':
                forced_remove |= blobs == blobs[q]
        if forced_remove.any():
            keep &= ~forced_remove
            cls_vol[forced_remove] = 5
    log('Skeletonising…')
    sk = skeletonize(keep.copy(), p['spur'])
    if not sk.any():
        raise ValueError('Skeleton is empty — lower the thresholds.')
    top = np.argwhere(sk)[np.argmax(np.argwhere(sk)[:, 2])]
    mask_vol = keep.copy()
    n_stubs = 0
    if p['water_filter'] and blobs.max():
        active = np.zeros(keep.shape, bool)
        status = {}
        for b in range(1, blobs.max() + 1):
            B = blobs == b
            if not B.any():
                continue
            c = np.array(ndi.center_of_mass(B))
            if forced_remove[B].any():
                status[b] = ('removed by you', c, int(B.sum()))
                continue
            if any(blobs[q] == b and a == 'root' for q, a in pts_edit):
                status[b] = ('kept as root by you', c, int(B.sum()))
                continue
            if np.linalg.norm(c - top) <= p['crown_protect']:
                status[b] = ('kept (plant base / crown)', c, int(B.sum()))
                continue
            active |= B
            status[b] = (None, c, int(B.sum()))
        sk, n_stubs = drop_stubs_in(sk, active)
        tube = ndi.binary_dilation(sk, morphology.ball(1))
        for b, (st, c, n) in status.items():
            B = blobs == b
            rem = 0
            if st is None:
                through = (sk & B).any()
                st = 'root passes through: thinned' if through else 'water pocket: removed'
                newB = tube & B
                rem = int(B.sum() - newB.sum())
                mask_vol[B] = False; mask_vol |= newB
            elif st == 'removed by you':
                rem = n
            blob_info.append(dict(id=b, center_voxel=[int(v) for v in c], voxels=n, removed_voxels=rem, action=st))
        # blobs that stay root are not shown as blobs
        for bi in blob_info:
            if bi['action'].startswith('kept'):
                blobs[blobs == bi['id']] = 0

    # axes and traits ----------------------------------------------
    S, df, coords, G, axes, base = root_axes(sk, sp)
    base_xyz = coords[base]
    for ax in axes:
        st = coords[ax['nodes'][0]]
        ax['start_dist_vox'] = float(np.linalg.norm(st - base_xyz))
        lv = ax['length'] / sp.mean()
        if ax['component'] != 0:
            ax['type'] = 'fragment'
        elif ax['start_dist_vox'] <= p['crown'] and lv >= p['min_main']:
            ax['type'] = 'main'
        elif lv >= p['min_lat']:
            ax['type'] = 'lateral'
        else:
            ax['type'] = 'minor'
        ax['pts_vox'] = axis_points(S, ax, coords)
    sk_lab = np.zeros(sk.shape, np.int32)
    for ax in sorted(axes, key=lambda a: a['length']):
        if len(ax['pts_vox']):
            sk_lab[tuple(np.round(ax['pts_vox']).astype(int).T)] = ax['id']
    deg = dict(G.degree())
    tips = np.array([coords[k] for k, d in deg.items() if d == 1 and k != base]).reshape(-1, 3)
    branch_pts = np.array([coords[k] for k, d in deg.items() if d >= 3]).reshape(-1, 3)
    total_len = float(df.branch_distance.sum())
    ptsm = np.argwhere(mask_vol)
    depth_vox = base_xyz[2] - np.argwhere(keep)[:, 2].min()
    horiz = ptsm[:, :2] * sp[:2]
    try:
        hull_vol = float(measure.regionprops(mask_vol.astype(np.uint8))[0].area_convex * sp.prod())
    except Exception:
        hull_vol = float('nan')
    traits = dict(
        voxel_size_mm=[float(x) for x in sp],
        total_root_length_mm=total_len,
        n_main_roots=sum(a['type'] == 'main' for a in axes),
        n_lateral_roots=sum(a['type'] == 'lateral' for a in axes),
        n_fragments=sum(a['type'] == 'fragment' for a in axes),
        n_root_tips=len(tips),
        n_branch_points=len(branch_pts),
        main_root_length_mm=sum(a['length'] for a in axes if a['type'] == 'main'),
        lateral_root_length_mm=sum(a['length'] for a in axes if a['type'] == 'lateral'),
        longest_root_mm=max(a['length'] for a in axes),
        rooting_depth_mm=float(depth_vox * sp[2]),
        max_lateral_spread_mm=float(max(np.ptp(horiz[:, 0]), np.ptp(horiz[:, 1]))),
        root_volume_mm3=float(mask_vol.sum() * sp.prod()),
        convex_hull_volume_mm3=hull_vol,
        mean_diameter_est_mm=float(2 * np.sqrt(mask_vol.sum() * sp.prod() / (np.pi * total_len))),
        n_water_blobs=len(blob_info),
        water_volume_removed_mm3=float(sum(b['removed_voxels'] for b in blob_info) * sp.prod()),
        water_stub_branches_removed=int(n_stubs),
        base_voxel=[int(v) for v in base_xyz],
    )
    bins = np.arange(0, depth_vox + 11, 10)
    prof = np.zeros(max(len(bins) - 1, 1))
    for bi in df.index:
        pc = S.path_coordinates(bi)
        seg = np.linalg.norm(np.diff(pc * sp, axis=0), axis=1)
        d = base_xyz[2] - (pc[:-1, 2] + pc[1:, 2]) / 2
        idx = np.clip(np.digitize(d, bins) - 1, 0, len(prof) - 1)
        np.add.at(prof, idx, seg)
    traits['length_by_depth'] = dict(bin_top_mm=(bins[:-1] * sp[2]).tolist(), length_mm=prof.round(2).tolist())
    rows = []
    for ax in sorted(axes, key=lambda a: -a['length']):
        if ax['type'] == 'minor':
            continue
        s_, t_ = ax['pts_vox'][0], ax['pts_vox'][-1]
        rows.append(dict(root_id=ax['id'], type=ax['type'], parent_id=ax['parent'] or '',
                         length_mm=round(ax['length'], 2),
                         tip_depth_mm=round(float((base_xyz[2] - t_[2]) * sp[2]), 2),
                         start_voxel=' '.join(str(int(v)) for v in s_),
                         tip_voxel=' '.join(str(int(v)) for v in t_)))
    return dict(params=p, z=z, cand=cand, cls_vol=cls_vol,
                mask=keep, mask_vol=mask_vol, blobs=blobs, blob_info=blob_info,
                sk=sk, sk_lab=sk_lab, axes=axes, tips=tips, branch_pts=branch_pts,
                traits=traits, roots=rows, messages=msgs)


# ----------------------------------------------------------------- exports
def scalar_traits(t):
    return {k: v for k, v in t.items() if not isinstance(v, (list, dict))}


def export_traits_csv(path, runs):
    """runs: list of (name, result). One row per run."""
    keys = []
    for _, r in runs:
        for k in scalar_traits(r['traits']):
            if k not in keys:
                keys.append(k)
    pkeys = ['lo', 'hi', 'sigma', 'water_filter', 'blob_ratio', 'n_markers', 'min_frag', 'frag_dist']
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['run'] + keys + ['param_' + k for k in pkeys])
        for name, r in runs:
            t = scalar_traits(r['traits'])
            w.writerow([name] + [round(t[k], 3) if isinstance(t.get(k), float) else t.get(k, '') for k in keys]
                       + [r['params'][k] for k in pkeys])


def export_roots_csv(path, result):
    rows = result['roots']
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ['root_id'])
        w.writeheader(); w.writerows(rows)


def export_mat(path, result, im=None):
    d = dict(root_mask=result['mask_vol'].astype(np.uint8),
             root_mask_topology=result['mask'].astype(np.uint8),
             skeleton_root_id=result['sk_lab'], water_blobs=result['blobs'],
             object_class=result['cls_vol'], tips_voxel=result['tips'], branch_points_voxel=result['branch_pts'],
             class_codes=np.array([f'{k}={v}' for k, v in CLASS_NAMES.items()], dtype=object))
    if im is not None:
        d['image'] = im
    sio.savemat(path, d, do_compression=True)


def export_tif(folder, result):
    import tifffile
    for name, arr in [('root_mask', result['mask_vol'].astype(np.uint8) * 255),
                      ('skeleton', (result['sk_lab'] > 0).astype(np.uint8) * 255),
                      ('water_blobs', (result['blobs'] > 0).astype(np.uint8) * 255)]:
        tifffile.imwrite(os.path.join(folder, name + '.tif'), np.moveaxis(arr, 2, 0)[::-1])


def export_rsml(path, result, name='scan'):
    """RSML (root system markup language) — readable by RootNav, ArchiDART, SmartRoot, etc."""
    sp = np.array(result['params']['voxel'])
    root = ET.Element('rsml')
    md = ET.SubElement(root, 'metadata')
    for k, v in [('version', '1'), ('unit', 'mm'), ('resolution', '1'), ('software', 'root_analysis.py'),
                 ('file-key', name)]:
        ET.SubElement(md, k).text = v
    plant = ET.SubElement(ET.SubElement(root, 'scene'), 'plant', id='1', label='wheat')
    axes = {a['id']: a for a in result['axes'] if a['type'] != 'minor'}
    elems = {}

    def add(ax):
        if ax['id'] in elems:
            return elems[ax['id']]
        par = ax['parent']
        while par and par not in axes:
            par = next((a['parent'] for a in result['axes'] if a['id'] == par), None)
        parent_el = add(axes[par]) if (par and ax['type'] != 'main') else plant
        el = ET.SubElement(parent_el, 'root', id=f"r{ax['id']}", label=ax['type'])
        poly = ET.SubElement(ET.SubElement(el, 'geometry'), 'polyline')
        for q in ax['pts_vox'] * sp:
            ET.SubElement(poly, 'point', x=f'{q[0]:.2f}', y=f'{q[1]:.2f}', z=f'{q[2]:.2f}')
        elems[ax['id']] = el
        return el
    for a in sorted(axes.values(), key=lambda a: a['level']):
        add(a)
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding='utf-8', xml_declaration=True)


def export_html(path, result, title='Root system'):
    """Stand-alone interactive 3D page (works offline)."""
    import plotly.graph_objects as go
    sp = tuple(result['params']['voxel'])
    traces = []

    def mesh(vol, color, op, name, by_height=False, visible=True):
        if vol.sum() < 10:
            return
        v, f, _, _ = measure.marching_cubes(ndi.gaussian_filter(vol.astype(float), 0.8), 0.4, spacing=sp)
        kw = dict(intensity=v[:, 2], colorscale=[[0, '#6b4a2b'], [0.5, '#c79b6b'], [1, '#f3e3c7']],
                  showscale=False) if by_height else dict(color=color)
        traces.append(go.Mesh3d(x=v[:, 0], y=v[:, 1], z=v[:, 2], i=f[:, 0], j=f[:, 1], k=f[:, 2],
                                opacity=op, name=name, showlegend=True, hoverinfo='skip', visible=visible,
                                lighting=dict(ambient=0.55, diffuse=0.8, specular=0.25), **kw))
    mesh(result['mask_vol'], None, 0.42, 'Root surface', by_height=True)
    removed = result['mask'] & ~result['mask_vol'] | (result['cls_vol'] == 5)
    mesh(removed, '#4fa3ff', 0.35, 'Water removed')
    mesh(result['cls_vol'] == 2, '#8a8178', 0.6, 'Markers', visible='legendonly')
    style = {'main': ('#f2b45a', 6), 'lateral': ('#7fc4b8', 3.5), 'fragment': ('#c98bd6', 3.5)}
    for t, (col, w) in style.items():
        x, y, zz, txt = [], [], [], []
        for a in result['axes']:
            if a['type'] != t:
                continue
            for q in a['pts_vox'] * np.array(sp):
                x.append(q[0]); y.append(q[1]); zz.append(q[2]); txt.append(f"{t} #{a['id']}: {a['length']:.0f} mm")
            x.append(None); y.append(None); zz.append(None); txt.append('')
        if x:
            traces.append(go.Scatter3d(x=x, y=y, z=zz, mode='lines', name=t, text=txt, hoverinfo='text',
                                       line=dict(color=col, width=w)))
    fig = go.Figure(traces)
    ax = dict(showbackground=False, gridcolor='#2b2520', color='#7d7366', title='')
    fig.update_layout(template='plotly_dark', paper_bgcolor='#15120f', height=850, title=title,
                      scene=dict(aspectmode='data', xaxis=ax, yaxis=ax, zaxis=ax,
                                 camera=dict(eye=dict(x=1.6, y=1.3, z=0.55))),
                      margin=dict(l=0, r=0, t=50, b=0))
    t = scalar_traits(result['traits'])
    table = ''.join(f"<tr><td>{k.replace('_', ' ')}</td><td style='text-align:right'><b>{(round(v, 1) if isinstance(v, float) else v)}</b></td></tr>"
                    for k, v in t.items())
    page = (f"<!DOCTYPE html><html><head><meta charset='utf-8'><title>{title}</title><style>body{{margin:0;background:#15120f;"
            f"color:#efe7dc;font-family:Segoe UI,Arial,sans-serif;display:flex;flex-wrap:wrap}}#v{{flex:1 1 700px}}"
            f"#t{{flex:0 0 340px;padding:20px;font-size:13px}}td{{padding:5px 8px;border-bottom:1px solid #2f2924}}"
            f"table{{border-collapse:collapse;width:100%}}</style></head><body><div id='v'>"
            f"{fig.to_html(include_plotlyjs=True, full_html=False)}</div><div id='t'><h3>Root traits</h3>"
            f"<table>{table}</table></div></body></html>")
    open(path, 'w', encoding='utf-8').write(page)


def export_all(folder, result, name='scan', im=None, runs=None, html=True):
    os.makedirs(folder, exist_ok=True)
    export_traits_csv(os.path.join(folder, 'traits.csv'), runs or [(name, result)])
    export_roots_csv(os.path.join(folder, 'roots.csv'), result)
    with open(os.path.join(folder, 'traits.json'), 'w') as f:
        json.dump(dict(result['traits'], water_blobs=result['blob_info'], params=result['params']), f, indent=2, default=float)
    export_mat(os.path.join(folder, 'segmentation.mat'), result, im)
    export_rsml(os.path.join(folder, 'roots.rsml'), result, name)
    if html:
        export_html(os.path.join(folder, 'viewer.html'), result, title=name)


# ----------------------------------------------------------------- CLI
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mat')
    ap.add_argument('--var', default=None)
    ap.add_argument('--voxel', type=float, nargs=3, default=DEFAULTS['voxel'])
    ap.add_argument('--vertical-axis', type=int, default=2)
    ap.add_argument('--base-low', action='store_true', help='plant base at the LOW index of the vertical axis')
    ap.add_argument('--lo', type=float, default=DEFAULTS['lo'])
    ap.add_argument('--hi', type=float, default=DEFAULTS['hi'])
    ap.add_argument('--markers', type=int, default=DEFAULTS['n_markers'])
    ap.add_argument('--blob-ratio', type=float, default=DEFAULTS['blob_ratio'])
    ap.add_argument('--no-water-filter', action='store_true')
    ap.add_argument('--no-html', action='store_true')
    ap.add_argument('--out', default='results')
    a = ap.parse_args()
    im, var = load(a.mat, a.var)
    im = orient(im, a.vertical_axis, not a.base_low)
    params = dict(voxel=tuple(a.voxel), lo=a.lo, hi=a.hi, n_markers=a.markers,
                  blob_ratio=a.blob_ratio, water_filter=not a.no_water_filter)
    r = analyze(im, params)
    name = os.path.splitext(os.path.basename(a.mat))[0]
    export_all(a.out, r, name, html=not a.no_html)
    print(json.dumps(scalar_traits(r['traits']), indent=2, default=float))


if __name__ == '__main__':
    main()
