"""
root_viewer.py — interactive 3D viewer and analysis app for MRI root scans (.mat)

    conda activate roots
    python root_viewer.py                    # then File > Open .mat in the panel
    python root_viewer.py scan.mat           # open a scan directly

Needs root_analysis.py in the same folder.
Requires: napari[all] numpy scipy scikit-image skan networkx plotly tifffile h5py
"""
import os, sys, copy
import numpy as np
from scipy import ndimage as ndi
import napari
from napari.utils.colormaps import DirectLabelColormap
from qtpy.QtCore import Qt
from qtpy.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QGroupBox, QPushButton,
                            QLabel, QDoubleSpinBox, QSpinBox, QCheckBox, QComboBox, QFileDialog,
                            QTableWidget, QTableWidgetItem, QLineEdit, QScrollArea, QHeaderView,
                            QApplication, QMessageBox, QAbstractItemView)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import root_analysis as ra

COL = dict(root='#d9b48a', main='#f2b45a', lateral='#5fd0c0', fragment='#c98bd6', water='#4fa3ff',
           marker='#9c9286', noise='#e05a5a', excluded='#ff4fb0', sel='#ff00ff', tip='#ffe14d', branch='#ff7043')
RUN_COLORS = ['#ff6b6b', '#4dabf7', '#69db7c', '#ffd43b', '#da77f2', '#ffa94d', '#38d9a9', '#f783ac']
CLASS_COLOR = {2: COL['marker'], 3: COL['noise'], 4: COL['excluded']}
KEY_TRAITS = [('n_main_roots', 'Main roots'), ('n_lateral_roots', 'Laterals'),
              ('total_root_length_mm', 'Total length (mm)'), ('rooting_depth_mm', 'Depth (mm)'),
              ('n_root_tips', 'Tips'), ('root_volume_mm3', 'Volume (mm³)'), ('n_water_blobs', 'Water blobs')]


# ---------- orientation helpers: internal (i, j, k↑) -> display (i, row↓, col)
def to_disp(a):
    return np.ascontiguousarray(np.transpose(a, (0, 2, 1))[:, ::-1, :])


def pts_to_disp(p, K):
    p = np.asarray(p, float).reshape(-1, 3)
    return np.stack([p[:, 0], K - 1 - p[:, 2], p[:, 1]], 1)


def pt_from_disp(d, K):
    return (int(round(d[0])), int(round(d[2])), int(round(K - 1 - d[1])))


def disp_scale(v):
    return (v[0], v[2], v[1])


def dspin(val, lo, hi, step, dec=2, tip=''):
    w = QDoubleSpinBox(); w.setRange(lo, hi); w.setSingleStep(step); w.setDecimals(dec); w.setValue(val)
    w.setToolTip(tip); return w


def ispin(val, lo, hi, tip=''):
    w = QSpinBox(); w.setRange(lo, hi); w.setValue(val); w.setToolTip(tip); return w


class RootApp(QWidget):
    def __init__(self, viewer):
        super().__init__()
        self.v = viewer
        self.im_raw = None; self.im = None; self.path = None
        self.cache = {}; self.result = None
        self.edits = []            # list of (internal_point, 'root'|'nonroot', description)
        self.runs = []             # list of dict(name, result, layer, color)
        self.selection = None
        self._build_ui()
        self.v.mouse_double_click_callbacks.append(self._on_double_click)

    # ------------------------------------------------------------ UI
    def _build_ui(self):
        outer = QVBoxLayout(self); outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea(); scroll.setWidgetResizable(True); outer.addWidget(scroll)
        body = QWidget(); scroll.setWidget(body); body.setMinimumWidth(470); self.setMinimumWidth(500)
        L = QVBoxLayout(body)

        # File
        g = QGroupBox('1 · Scan'); f = QFormLayout(g)
        b = QPushButton('Open .mat file…'); b.clicked.connect(self.open_dialog); f.addRow(b)
        self.lbl_file = QLabel('No file loaded'); self.lbl_file.setWordWrap(True); f.addRow(self.lbl_file)
        self.cmb_var = QComboBox(); f.addRow('Variable', self.cmb_var)
        self.cmb_vert = QComboBox(); self.cmb_vert.addItems(['axis 0', 'axis 1', 'axis 2']); self.cmb_vert.setCurrentIndex(2)
        f.addRow('Vertical axis', self.cmb_vert)
        self.chk_basehigh = QCheckBox('Plant base at high index'); self.chk_basehigh.setChecked(True); f.addRow(self.chk_basehigh)
        row = QHBoxLayout()
        self.vox = [dspin(2.0, 0.001, 100, 0.1, 3) for _ in range(3)]
        for w in self.vox:
            row.addWidget(w)
        f.addRow('Voxel size (mm)', row)
        b = QPushButton('Reload with these settings'); b.clicked.connect(self.reload); f.addRow(b)
        row = QHBoxLayout()
        for lab, fn in [('Front', lambda: self.front_view(0)), ('Angled', lambda: self.front_view(30)),
                        ('Side', lambda: self.front_view(90)), ('Top', self.top_view),
                        ('2D slices', self.toggle_2d)]:
            bb = QPushButton(lab); bb.clicked.connect(fn); row.addWidget(bb)
        f.addRow('View', row)
        L.addWidget(g)

        # Detection
        g = QGroupBox('2 · Detection settings'); f = QFormLayout(g)
        d = ra.DEFAULTS
        self.p_lo = dspin(d['lo'], 0.5, 50, 0.5, 1, 'Voxels above this many noise SDs can join a root (growing threshold)')
        self.p_hi = dspin(d['hi'], 0.5, 100, 0.5, 1, 'A root must contain voxels above this many noise SDs (seed threshold)')
        self.p_sigma = dspin(d['sigma'], 0.0, 3, 0.1, 1, 'Smoothing before thresholding (voxels)')
        self.p_mark = ispin(d['n_markers'], 0, 10, 'Bright detached blobs treated as reference markers')
        self.p_frag = ispin(d['min_frag'], 1, 5000, 'Smallest detached piece kept as root (voxels)')
        self.p_gap = ispin(d['frag_dist'], 0, 50, 'Largest gap between a detached piece and the roots (voxels)')
        self.p_water = QCheckBox('Water-blob filter'); self.p_water.setChecked(d['water_filter'])
        self.p_ratio = dspin(d['blob_ratio'], 0.2, 5, 0.1, 2, 'Higher = only very round regions count as water')
        self.p_minblob = ispin(d['min_blob'], 1, 5000, 'Smallest blob core (voxels)')
        self.p_crownp = ispin(d['crown_protect'], 0, 100, 'Blobs this close to the plant base are left alone')
        self.p_crown = ispin(d['crown'], 1, 200, 'Roots starting within this radius of the base count as main roots')
        self.p_minmain = ispin(d['min_main'], 1, 500, 'Shortest main root (voxels)')
        self.p_minlat = ispin(d['min_lat'], 1, 500, 'Shortest lateral root (voxels)')
        for lab, w in [('Low threshold (SD)', self.p_lo), ('High threshold (SD)', self.p_hi),
                       ('Smoothing σ', self.p_sigma), ('Markers to drop', self.p_mark),
                       ('Min detached piece', self.p_frag), ('Max gap to roots', self.p_gap)]:
            f.addRow(lab, w)
        f.addRow(self.p_water)
        for lab, w in [('Blob strictness', self.p_ratio), ('Min blob size', self.p_minblob),
                       ('Protect base radius', self.p_crownp), ('Main-root radius', self.p_crown),
                       ('Min main length', self.p_minmain), ('Min lateral length', self.p_minlat)]:
            f.addRow(lab, w)
        row = QHBoxLayout()
        self.btn_run = QPushButton('▶  Run analysis'); self.btn_run.clicked.connect(self.run)
        self.btn_run.setStyleSheet('font-weight:600;padding:6px')
        b2 = QPushButton('Defaults'); b2.clicked.connect(self.reset_defaults)
        row.addWidget(self.btn_run, 3); row.addWidget(b2, 1); f.addRow(row)
        self.lbl_status = QLabel(''); self.lbl_status.setWordWrap(True); f.addRow(self.lbl_status)
        L.addWidget(g)

        # Selection
        g = QGroupBox('3 · Select & correct objects'); f = QVBoxLayout(g)
        f.addWidget(QLabel('Double-click an object in the 3D view (non-root object, water blob, '
                           'root or skeleton) to select it. Then:'))
        self.lbl_sel = QLabel('Nothing selected'); self.lbl_sel.setWordWrap(True)
        self.lbl_sel.setStyleSheet('color:#ff8cff'); f.addWidget(self.lbl_sel)
        row = QHBoxLayout()
        b = QPushButton('✓ Mark as root'); b.clicked.connect(lambda: self.add_edit('root')); row.addWidget(b)
        b = QPushButton('✗ Mark as non-root'); b.clicked.connect(lambda: self.add_edit('nonroot')); row.addWidget(b)
        f.addLayout(row)
        row = QHBoxLayout()
        b = QPushButton('Undo last'); b.clicked.connect(self.undo_edit); row.addWidget(b)
        b = QPushButton('Clear all corrections'); b.clicked.connect(self.clear_edits); row.addWidget(b)
        f.addLayout(row)
        self.lbl_edits = QLabel('Corrections: none'); self.lbl_edits.setWordWrap(True); f.addWidget(self.lbl_edits)
        hint = QLabel('Fine edits: select the “Manual edits” layer, use the brush with label 1 = erase '
                      'or 2 = add root, then Run again. Painting works best in 2D view (toggle 2D/3D, bottom-left).')
        hint.setWordWrap(True); hint.setStyleSheet('color:#9a9a9a;font-size:11px'); f.addWidget(hint)
        L.addWidget(g)

        # Results
        g = QGroupBox('4 · Results'); f = QVBoxLayout(g)
        self.tbl = QTableWidget(0, 2); self.tbl.setHorizontalHeaderLabels(['Trait', 'Value'])
        self.tbl.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.tbl.verticalHeader().setVisible(False); self.tbl.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tbl.setMinimumHeight(260); f.addWidget(self.tbl)
        f.addWidget(QLabel('Individual roots — click a row to highlight it in 3D:'))
        self.tbl_roots = QTableWidget(0, 4); self.tbl_roots.setHorizontalHeaderLabels(['#', 'Type', 'Length (mm)', 'Tip depth (mm)'])
        self.tbl_roots.verticalHeader().setVisible(False); self.tbl_roots.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tbl_roots.setSelectionBehavior(QAbstractItemView.SelectRows); self.tbl_roots.setMinimumHeight(200)
        self.tbl_roots.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.tbl_roots.cellClicked.connect(lambda r, c: self.select('skeleton', int(self.tbl_roots.item(r, 0).text())))
        f.addWidget(self.tbl_roots)
        L.addWidget(g)

        # Compare
        g = QGroupBox('5 · Compare runs'); f = QVBoxLayout(g)
        row = QHBoxLayout()
        self.ed_name = QLineEdit(); self.ed_name.setPlaceholderText('run name (optional)')
        b = QPushButton('Save current run'); b.clicked.connect(self.save_run)
        row.addWidget(self.ed_name); row.addWidget(b); f.addLayout(row)
        self.tbl_runs = QTableWidget(0, 0); self.tbl_runs.verticalHeader().setVisible(False)
        self.tbl_runs.setEditTriggers(QAbstractItemView.NoEditTriggers); self.tbl_runs.setMinimumHeight(160)
        self.tbl_runs.itemChanged.connect(self._run_toggled)
        self.tbl_runs.setSelectionBehavior(QAbstractItemView.SelectRows)
        f.addWidget(self.tbl_runs)
        row = QHBoxLayout()
        b = QPushButton('Load settings of selected run'); b.clicked.connect(self.load_run_settings); row.addWidget(b)
        b = QPushButton('Delete selected run'); b.clicked.connect(self.delete_run); row.addWidget(b)
        f.addLayout(row)
        tip = QLabel('Tick “Show” to overlay a saved run’s root skeleton in its own colour (hide the current layers to compare).')
        tip.setStyleSheet('color:#9a9a9a;font-size:11px'); f.addWidget(tip)
        L.addWidget(g)

        # Export
        g = QGroupBox('6 · Export'); f = QVBoxLayout(g)
        self.ex = {}
        for key, lab, on in [('traits', 'Traits table (all saved runs + current) .csv', True),
                             ('roots', 'Per-root table .csv', True),
                             ('json', 'Traits + settings + water-blob report .json', True),
                             ('mat', 'Segmentation volumes .mat (mask, skeleton, blobs, classes)', True),
                             ('tif', 'TIFF stacks (mask, skeleton, blobs) for Fiji/ImageJ', False),
                             ('rsml', 'RSML root architecture (RootNav, ArchiDART…)', True),
                             ('html', 'Interactive 3D HTML page (shareable, offline)', True),
                             ('png', 'Screenshot of current 3D view .png', True)]:
            c = QCheckBox(lab); c.setChecked(on); self.ex[key] = c; f.addWidget(c)
        b = QPushButton('Export to folder…'); b.clicked.connect(self.export_dialog); f.addWidget(b)
        L.addWidget(g)
        L.addStretch(1)

    # ------------------------------------------------------------ params
    def params(self):
        return dict(voxel=tuple(w.value() for w in self.vox), lo=self.p_lo.value(), hi=self.p_hi.value(),
                    sigma=self.p_sigma.value(), n_markers=self.p_mark.value(), min_frag=self.p_frag.value(),
                    frag_dist=self.p_gap.value(), water_filter=self.p_water.isChecked(),
                    blob_ratio=self.p_ratio.value(), min_blob=self.p_minblob.value(),
                    crown_protect=self.p_crownp.value(), crown=self.p_crown.value(),
                    min_main=self.p_minmain.value(), min_lat=self.p_minlat.value())

    def set_params(self, p):
        for w, k in [(self.p_lo, 'lo'), (self.p_hi, 'hi'), (self.p_sigma, 'sigma'), (self.p_ratio, 'blob_ratio')]:
            w.setValue(p[k])
        for w, k in [(self.p_mark, 'n_markers'), (self.p_frag, 'min_frag'), (self.p_gap, 'frag_dist'),
                     (self.p_minblob, 'min_blob'), (self.p_crownp, 'crown_protect'), (self.p_crown, 'crown'),
                     (self.p_minmain, 'min_main'), (self.p_minlat, 'min_lat')]:
            w.setValue(int(p[k]))
        self.p_water.setChecked(p['water_filter'])

    def reset_defaults(self):
        self.set_params(ra.DEFAULTS)

    def status(self, msg):
        self.lbl_status.setText(msg); self.v.status = msg; QApplication.processEvents()

    # ------------------------------------------------------------ loading
    def open_dialog(self):
        p, _ = QFileDialog.getOpenFileName(self, 'Open MRI scan', '', 'MATLAB files (*.mat)')
        if p:
            self.open(p)

    def open(self, path, var=None):
        self.path = path
        vars_ = ra.list_mat_vars(path)
        self.cmb_var.blockSignals(True); self.cmb_var.clear()
        for n, s in vars_:
            self.cmb_var.addItem(f'{n}  {tuple(s)}', n)
        if var or any(n == 'im' for n, _ in vars_):
            self.cmb_var.setCurrentIndex([n for n, _ in vars_].index(var or 'im'))
        self.cmb_var.blockSignals(False)
        self.reload()

    def reload(self):
        if not self.path:
            return
        var = self.cmb_var.currentData()
        self.im_raw, var = ra.load(self.path, var)
        self.im = ra.orient(self.im_raw, self.cmb_vert.currentIndex(), self.chk_basehigh.isChecked())
        self.K = self.im.shape[2]
        self.cache = {}; self.result = None; self.edits = []; self.selection = None
        for r in self.runs:
            if r['layer'] in self.v.layers:
                self.v.layers.remove(r['layer'])
        self.runs = []; self._refresh_runs(); self._refresh_edits()
        self.v.layers.clear()
        sc = disp_scale(self.params()['voxel'])
        d = to_disp(self.im)
        lo, hi = np.percentile(d, [99.3, 99.98])
        self.L_img = self.v.add_image(d, name='MRI image (original)', scale=sc, colormap='gray',
                                      contrast_limits=(lo, hi), rendering='mip', blending='additive', opacity=0.8, gamma=0.8)
        self.L_edit = self.v.add_labels(np.zeros(d.shape, np.uint8), name='Manual edits (1 erase, 2 add)', scale=sc,
                                        opacity=0.7)
        self.L_edit.colormap = DirectLabelColormap(color_dict={None: 'transparent', 0: 'transparent', 1: '#ff3030', 2: '#30ff60'})
        self.L_edit.brush_size = 4; self.L_edit.selected_label = 1
        self.lbl_file.setText(f'{os.path.basename(self.path)}\nvariable “{var}”, shape {self.im_raw.shape}')
        self.v.dims.ndisplay = 3
        self.front_view()
        self.v.title = 'Root viewer — ' + os.path.basename(self.path)
        self.run()

    def front_view(self, turn=30):
        """Side view with the plant base at the top, rotated `turn` degrees about the vertical."""
        a = np.deg2rad(turn)
        try:
            self.v.dims.ndisplay = 3
            self.cam().set_view_direction((np.cos(a), 0.15, np.sin(a)), up_direction=(0, -1, 0))
            self.v.reset_view(); self.cam().zoom *= 1.4
        except Exception:
            self.cam().angles = (0, turn, 90)

    def cam(self):
        sc = getattr(self.v, 'scene', None)
        return sc.camera if sc is not None and hasattr(sc, 'camera') else self.v.camera

    def top_view(self):
        self.v.dims.ndisplay = 3
        try:
            self.cam().set_view_direction((0, 1, 0), up_direction=(-1, 0, 0))
        except Exception:
            self.cam().angles = (0, 0, 0)

    def toggle_2d(self):
        self.v.dims.ndisplay = 2 if self.v.dims.ndisplay == 3 else 3
        if self.v.dims.ndisplay == 3:
            self.front_view(30)
        else:
            self.v.dims.order = (0, 1, 2)

    # ------------------------------------------------------------ analysis
    def run(self):
        if self.im is None:
            return
        edits = dict(points=[(q, a) for q, a, _ in self.edits])
        paint_disp = self.L_edit.data
        if paint_disp.any():
            edits['paint'] = np.transpose(paint_disp[:, ::-1, :], (0, 2, 1))
        self.btn_run.setEnabled(False)
        try:
            self.result = ra.analyze(self.im, self.params(), edits, cache=self.cache, log=self.status)
        except Exception as e:
            self.status(f'⚠ {e}')
            QMessageBox.warning(self, 'Analysis failed', str(e))
            return
        finally:
            self.btn_run.setEnabled(True)
        self._show_result()
        t = self.result['traits']
        self.status(f"Done: {t['n_main_roots']} main, {t['n_lateral_roots']} laterals, "
                    f"{t['total_root_length_mm']/10:.1f} cm total, {t['n_water_blobs']} water blobs.")

    def _labels(self, name, data, colors, opacity=0.6, rendering='iso_categorical', visible=True):
        sc = disp_scale(self.params()['voxel'])
        if name in self.v.layers:
            L = self.v.layers[name]; L.data = data; L.scale = sc
        else:
            L = self.v.add_labels(data, name=name, scale=sc, opacity=opacity, visible=visible)
            L.rendering = rendering
        cd = {None: 'transparent', 0: 'transparent'}; cd.update(colors)
        L.colormap = DirectLabelColormap(color_dict=cd)
        return L

    def _show_result(self):
        r = self.result; sc = disp_scale(self.params()['voxel'])
        # non-root candidate objects, each with its own id (so they can be picked), one layer per class
        cls = r['cls_vol']; cand = r['cand']
        self.nonroot_layers = []
        for code, name, vis in [(2, 'Markers', True), (4, 'Excluded by you', True), (3, 'Detached noise', False)]:
            arr = np.where(cls == code, cand, 0)
            ids = np.unique(arr); ids = ids[ids > 0]
            L = self._labels(name, to_disp(arr), {int(i): CLASS_COLOR[code] for i in ids}, 0.8, visible=vis)
            self.nonroot_layers.append(name)
        bl = r['blobs'].copy()
        bl[(cls == 5) & (bl == 0)] = 0
        self.L_blob = self._labels('Water blobs', to_disp(bl), {int(i): COL['water'] for i in np.unique(bl) if i}, 0.55)
        self.L_mask = self._labels('Root mask', to_disp(r['mask_vol'].astype(np.uint8)), {1: COL['root']}, 0.35)
        typ = {a['id']: a['type'] for a in r['axes']}
        skl = to_disp(ndi.grey_dilation(r['sk_lab'], size=(2, 2, 2)) * (ndi.binary_dilation(r['sk_lab'] > 0)))
        self.L_sk = self._labels('Skeleton (main / lateral / fragment)', skl,
                                 {i: COL.get(typ.get(i, 'minor'), '#777777') for i in np.unique(skl) if i}, 1.0)
        for name, pts, col, sz in [('Root tips', r['tips'], COL['tip'], 2.5), ('Branch points', r['branch_pts'], COL['branch'], 2.0)]:
            dp = pts_to_disp(pts, self.K)
            if name in self.v.layers:
                Lp = self.v.layers[name]; Lp.data = dp; Lp.scale = sc
            else:
                Lp = self.v.add_points(dp, name=name, scale=sc, size=sz, face_color=col, border_width=0,
                                       visible=(name == 'Root tips'))
        if 'Selection' in self.v.layers:
            self.v.layers['Selection'].data = np.zeros(self.v.layers['Selection'].data.shape, np.uint8)
        # keep painting layer on top of list for convenience
        self._fill_table()

    def _fill_table(self):
        t = ra.scalar_traits(self.result['traits'])
        nice = {'voxel_size_mm': None, 'base_voxel': None}
        rows = [(k, v) for k, v in t.items() if k not in nice]
        self.tbl.setRowCount(len(rows))
        for i, (k, v) in enumerate(rows):
            self.tbl.setItem(i, 0, QTableWidgetItem(k.replace('_mm3', ' (mm³)').replace('_mm', ' (mm)').replace('_', ' ')))
            it = QTableWidgetItem(f'{v:,.1f}' if isinstance(v, float) else str(v))
            it.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter); self.tbl.setItem(i, 1, it)
        rows = self.result['roots']
        self.tbl_roots.setRowCount(len(rows))
        for i, rr in enumerate(rows):
            for j, k in enumerate(['root_id', 'type', 'length_mm', 'tip_depth_mm']):
                it = QTableWidgetItem(str(rr[k])); self.tbl_roots.setItem(i, j, it)

    # ------------------------------------------------------------ selection
    def _on_double_click(self, viewer, event):
        if self.result is None:
            return
        order = [('Markers', 'object'), ('Excluded by you', 'object'), ('Detached noise', 'object'), ('Water blobs', 'blob'),
                 ('Skeleton (main / lateral / fragment)', 'skeleton'), ('Root mask', 'root')]
        for name, kind in order:
            if name not in self.v.layers or not self.v.layers[name].visible:
                continue
            L = self.v.layers[name]
            try:
                val = L.get_value(event.position, view_direction=event.view_direction,
                                  dims_displayed=list(event.dims_displayed), world=True)
            except Exception:
                val = None
            if val:
                self.select(kind, int(val)); return
        self.lbl_sel.setText('Nothing under the cursor — try again on a visible object.')

    def select(self, kind, val):
        r = self.result
        if kind == 'object':
            vox = r['cand'] == val
            c = int(r['cls_vol'][vox][0])
            desc = f"{ra.CLASS_NAMES[c]} #{val} — {int(vox.sum())} voxels"
        elif kind == 'blob':
            vox = r['blobs'] == val
            info = next((b for b in r['blob_info'] if b['id'] == val), {})
            desc = f"water blob #{val} — {int(vox.sum())} voxels — {info.get('action', '')}"
        elif kind == 'skeleton':
            ax = next(a for a in r['axes'] if a['id'] == val)
            vox = r['sk_lab'] == val
            row = next((x for x in r['roots'] if x['root_id'] == val), {})
            desc = f"{ax['type']} root #{val} — {ax['length']:.0f} mm long, tip at {row.get('tip_depth_mm', '?')} mm depth"
        else:
            vox = r['mask_vol'].astype(bool)
            desc = 'main root system (to remove parts of it, use the Manual edits brush)'
        q = tuple(np.argwhere(vox)[len(np.argwhere(vox)) // 2])
        self.selection = (kind, val, q, desc)
        self.lbl_sel.setText('Selected: ' + desc)
        if kind == 'skeleton':
            vox = ndi.binary_dilation(vox, iterations=1)
        hl = to_disp(vox.astype(np.uint8))
        L = self._labels('Selection', hl, {1: COL['sel']}, 1.0)
        L.visible = True
        L.blending = 'additive'   # draw on top of everything so it is never hidden
        self.v.layers.move(self.v.layers.index(L), len(self.v.layers) - 1)

    def add_edit(self, action):
        if not self.selection:
            self.lbl_sel.setText('Select something first (double-click in 3D view).'); return
        kind, val, q, desc = self.selection
        if kind in ('skeleton', 'root'):
            QMessageBox.information(self, 'Not applicable',
                                    'Root/skeleton parts of the main system can’t be toggled as a whole.\n'
                                    'Use the “Manual edits” brush (1 = erase, 2 = add) and Run again.')
            return
        self.edits.append((q, action, f"{'✓ root' if action == 'root' else '✗ non-root'}: {desc.split(' — ')[0]}"))
        self._refresh_edits(); self.selection = None; self.run()

    def undo_edit(self):
        if self.edits:
            self.edits.pop(); self._refresh_edits(); self.run()

    def clear_edits(self):
        self.edits = []
        if hasattr(self, 'L_edit'):
            self.L_edit.data = np.zeros_like(self.L_edit.data)
        self._refresh_edits(); self.run()

    def _refresh_edits(self):
        self.lbl_edits.setText('Corrections: ' + ('; '.join(e[2] for e in self.edits) if self.edits else 'none'))

    # ------------------------------------------------------------ compare
    def save_run(self):
        if self.result is None:
            return
        i = len(self.runs)
        name = self.ed_name.text().strip() or f"Run {i+1} (lo {self.result['params']['lo']}, hi {self.result['params']['hi']}" \
                                                f"{', water' if self.result['params']['water_filter'] else ''})"
        col = RUN_COLORS[i % len(RUN_COLORS)]
        skel = ndi.binary_dilation(self.result['sk_lab'] > 0, iterations=1).astype(np.uint8)
        L = self.v.add_labels(to_disp(skel), name='Saved: ' + name,
                              scale=disp_scale(self.params()['voxel']), opacity=1.0, visible=False)
        L.rendering = 'iso_categorical'
        L.colormap = DirectLabelColormap(color_dict={None: 'transparent', 0: 'transparent', 1: col})
        self.runs.append(dict(name=name, result=copy.copy(self.result), layer=L, color=col,
                              edits=list(self.edits)))
        self.ed_name.clear(); self._refresh_runs()

    def _refresh_runs(self):
        cols = ['Show', 'Run'] + [n for _, n in KEY_TRAITS]
        self.tbl_runs.blockSignals(True)
        self.tbl_runs.setColumnCount(len(cols)); self.tbl_runs.setHorizontalHeaderLabels(cols)
        self.tbl_runs.setRowCount(len(self.runs))
        for i, r in enumerate(self.runs):
            c = QTableWidgetItem(); c.setFlags(Qt.ItemIsUserCheckable | Qt.ItemIsEnabled)
            c.setCheckState(Qt.Checked if r['layer'].visible else Qt.Unchecked)
            self.tbl_runs.setItem(i, 0, c)
            n = QTableWidgetItem(r['name']); n.setForeground(__import__('qtpy.QtGui', fromlist=['QColor']).QColor(r['color']))
            self.tbl_runs.setItem(i, 1, n)
            t = r['result']['traits']
            for j, (k, _) in enumerate(KEY_TRAITS):
                v = t[k]
                it = QTableWidgetItem(f'{v:,.0f}' if isinstance(v, float) else str(v))
                it.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter); self.tbl_runs.setItem(i, j + 2, it)
        self.tbl_runs.resizeColumnsToContents()
        self.tbl_runs.blockSignals(False)

    def _run_toggled(self, item):
        if item.column() == 0 and item.row() < len(self.runs):
            self.runs[item.row()]['layer'].visible = item.checkState() == Qt.Checked

    def _selected_run(self):
        rows = {i.row() for i in self.tbl_runs.selectedItems()}
        return min(rows) if rows else None

    def load_run_settings(self):
        i = self._selected_run()
        if i is not None:
            self.set_params(self.runs[i]['result']['params'])
            self.edits = list(self.runs[i]['edits']); self._refresh_edits(); self.run()

    def delete_run(self):
        i = self._selected_run()
        if i is not None:
            r = self.runs.pop(i)
            if r['layer'] in self.v.layers:
                self.v.layers.remove(r['layer'])
            self._refresh_runs()

    # ------------------------------------------------------------ export
    def export_dialog(self):
        if self.result is None:
            return
        d = QFileDialog.getExistingDirectory(self, 'Export results to folder')
        if d:
            self.export(d)

    def export(self, folder):
        os.makedirs(folder, exist_ok=True)
        r = self.result
        name = os.path.splitext(os.path.basename(self.path))[0]
        runs = [(x['name'], x['result']) for x in self.runs] + [('current', r)]
        done = []
        if self.ex['traits'].isChecked():
            ra.export_traits_csv(os.path.join(folder, 'traits.csv'), runs); done.append('traits.csv')
        if self.ex['roots'].isChecked():
            ra.export_roots_csv(os.path.join(folder, 'roots.csv'), r); done.append('roots.csv')
            for x in self.runs:
                safe = ''.join(ch if ch.isalnum() else '_' for ch in x['name'])[:40]
                ra.export_roots_csv(os.path.join(folder, f'roots_{safe}.csv'), x['result'])
        if self.ex['json'].isChecked():
            import json
            with open(os.path.join(folder, 'traits.json'), 'w') as f:
                json.dump(dict(r['traits'], water_blobs=r['blob_info'], params=r['params'],
                               corrections=[e[2] for e in self.edits]), f, indent=2, default=float)
            done.append('traits.json')
        if self.ex['mat'].isChecked():
            ra.export_mat(os.path.join(folder, 'segmentation.mat'), r); done.append('segmentation.mat')
        if self.ex['tif'].isChecked():
            ra.export_tif(folder, r); done.append('TIFF stacks')
        if self.ex['rsml'].isChecked():
            ra.export_rsml(os.path.join(folder, 'roots.rsml'), r, name); done.append('roots.rsml')
        if self.ex['html'].isChecked():
            self.status('Writing HTML viewer…')
            ra.export_html(os.path.join(folder, 'viewer.html'), r, title=name); done.append('viewer.html')
        if self.ex['png'].isChecked():
            import imageio.v3 as iio
            iio.imwrite(os.path.join(folder, 'screenshot.png'), self.v.screenshot(canvas_only=True, scale=2))
            done.append('screenshot.png')
        self.status('Exported to ' + folder + ': ' + ', '.join(done))
        return done


def _check_qt():
    """Detect the usual cause of 'Must construct a QApplication before a QWidget':
    two different Qt bindings / copies loaded at the same time."""
    import importlib.util, qtpy
    found = [b for b in ('PyQt5', 'PyQt6', 'PySide2', 'PySide6') if importlib.util.find_spec(b)]
    print(f'Qt binding used: {qtpy.API_NAME} (Qt {qtpy.QT_VERSION}); installed: {", ".join(found)}')
    if len(found) > 1:
        print('NOTE: several Qt bindings are installed. If the window fails to open, keep only one, e.g.\n'
              '   set QT_API=' + qtpy.API_NAME.lower() + '   (Windows)   then run again, or see README troubleshooting.')


def main():
    _check_qt()
    from napari.qt import get_qapp
    get_qapp()                       # create the QApplication before any widget
    viewer = napari.Viewer(title='Root viewer')
    app = RootApp(viewer)
    viewer.window.add_dock_widget(app, name='Root analysis', area='right')
    if len(sys.argv) > 1:
        app.open(sys.argv[1])
    napari.run()


if __name__ == '__main__':
    main()
