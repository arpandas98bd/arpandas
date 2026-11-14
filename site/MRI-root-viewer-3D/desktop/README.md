# Root Viewer — desktop version (Python + napari)

Two files, keep them in the same folder:

| File | What it is |
|---|---|
| `root_viewer.py` | The interactive app (3D view, settings, corrections, comparison, export) |
| `root_analysis.py` | The analysis engine. Also runs on its own from the command line for batch jobs |

---

## 1. Install (once)

Open **Anaconda Prompt** and run:

```
conda create -n roots -c conda-forge python=3.11 napari pyqt numpy scipy scikit-image networkx plotly tifffile h5py imageio -y
conda activate roots
pip install skan
```

## 2. Start the app

```
conda activate roots
cd C:\roots                         (the folder with the two .py files)
python root_viewer.py
```

Or open a scan directly: `python root_viewer.py "C:\data\my_scan.mat"`

The first analysis of a scan takes ~20–40 s (it computes the tube/blob shape maps once).
Changing settings and re-running after that takes ~3–15 s.

---

## 3. Using it

The window has three parts: **layer list** (left), **3D view** (middle), **Root analysis panel** (right).

### Panel section 1 · Scan
- **Open .mat file…**: pick the scan. If the file holds several 3D arrays, choose one under *Variable*.
- **Vertical axis / Plant base at high index**: set how the scan is oriented (defaults fit your current scans).
- **Voxel size (mm)**: 2 mm is assumed. Change it, then press **Reload with these settings**.
- **View buttons**: Front, Angled, Side, Top, or **2D slices**, which steps through slices with the slider under the view.

### Panel section 2 · Detection settings (hover over any box for an explanation)
| Setting | Effect |
|---|---|
| Low / High threshold (SD) | How bright (in noise units) something must be to count as root. **Lower = more faint roots, but more noise.** |
| Smoothing σ | Noise smoothing before detection |
| Markers to drop | Number of bright detached blobs treated as reference markers (set 0 if no markers) |
| Min detached piece / Max gap | Keeps root pieces separated from the main system by a small signal gap |
| Water-blob filter, Blob strictness | Removes round water pockets. Higher strictness = only very round blobs are removed |
| Protect base radius | The seed/crown at the top is never treated as water |
| Main-root radius, Min main / lateral length | How roots are classified as main (from the base) or lateral |

Press **▶ Run analysis** after changing anything.

### Layers (left list: eye icon = show/hide; click a layer to change opacity/colour)
| Layer | Shows |
|---|---|
| MRI image (original) | The raw scan as a 3D projection. Adjust *contrast limits* to taste |
| Root mask | Detected root volume |
| Skeleton | Root centrelines: **orange = main, teal = lateral, purple = detached fragment** |
| Root tips / Branch points | Yellow / orange dots |
| Water blobs | Blue: water removed by the filter |
| Markers / Excluded by you / Detached noise | Non-root objects (noise is hidden by default) |
| Manual edits | Your brush corrections |
| Selection | Magenta highlight of what you selected |
| Saved: … | Skeletons of saved runs, for comparison |

Mouse: **drag** = rotate, **scroll** = zoom, **Shift+drag** = pan.

### Panel section 3 · Select & correct objects
1. **Double-click** an object in the 3D view (a marker, noise speck, water blob or root). It turns magenta and the panel says what it is.
2. Press **✓ Mark as root** or **✗ Mark as non-root**. The analysis re-runs automatically.
   - A *marker/noise* object marked as root is added to the root system.
   - A *water blob* marked as non-root is removed completely; marked as root, it is kept untouched.
3. **Undo last** / **Clear all corrections** if needed.

**Brush edits** for anything else: click **2D slices**, select the *Manual edits* layer, pick the paint brush (top-left), and set *label* **1 = erase** or **2 = add root**. Paint over the slices, then press **Run analysis**.

### Panel section 4 · Results
Every trait for the current run. In the per-root table, **click a row** to highlight that root in 3D.

### Panel section 5 · Compare runs
1. Run with some settings and press **Save current run** (give it a name, e.g. "strict").
2. Change settings, run again, and save again.
3. The table compares the runs side by side. Tick **Show** to overlay each run's skeleton in its own colour (hide the current layers to see them clearly).
4. **Load settings of selected run** brings a saved run's settings (and corrections) back.

### Panel section 6 · Export
Tick what you want, press **Export to folder…**:

| File | Contents |
|---|---|
| `traits.csv` | One row per run (all saved runs + current), with the settings used |
| `roots.csv` (+ one per saved run) | Every root: type, parent, length, tip depth, coordinates |
| `traits.json` | All traits, settings, water-blob report and your corrections |
| `segmentation.mat` | Volumes for MATLAB: `root_mask`, `skeleton_root_id`, `water_blobs`, `object_class`, tips, branch points |
| `root_mask.tif`, `skeleton.tif`, `water_blobs.tif` | Image stacks for Fiji/ImageJ |
| `roots.rsml` | Standard root-architecture format (RootNav, ArchiDART, SmartRoot…) |
| `viewer.html` | Interactive 3D page you can email; opens in any browser, works offline |
| `screenshot.png` | The current 3D view at 2× resolution |

---

## 4. Batch mode (no window)

```
python root_analysis.py scan.mat --voxel 2 2 2 --out results\scan1
for %f in (*.mat) do python root_analysis.py "%f" --voxel 2 2 2 --out "results\%~nf"
```
Options: `--lo 2.5 --hi 5`, `--no-water-filter`, `--markers 0`, `--blob-ratio 1.5`, `--vertical-axis 0`, `--base-low`, `--no-html`.
Run `python root_analysis.py -h` for the full list.

## 5. Troubleshooting
| Problem | Fix |
|---|---|
| `ModuleNotFoundError` | Run `conda activate roots` first |
| Window is black / crashes on start | Update your graphics driver; or try `pip install PyQt5` in the env |
| "Nothing above threshold" | Lower the Low/High thresholds |
| Roots look upside down | Untick *Plant base at high index* or change *Vertical axis*, then Reload |
| Too much noise detected | Raise the thresholds, or raise *Min detached piece* |

## 6. Caveats
- Lengths are in mm only if the voxel size is right (2 mm assumed from your 2D pixel size).
- Near the plant base, roots touch at this resolution, so main-root counts there are estimates.
- Laterals thinner than the MRI resolution are missed, so lateral count and total length are lower bounds.
- Mean diameter is inflated by partial-volume blur. Use it only to compare scans.
