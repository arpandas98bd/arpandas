# Root Viewer: 3D MRI root analysis in the browser

Upload a 3D MRI scan (`.mat`) of a root system, view it in 3D, measure root number, length and depth,
correct the detection, compare settings and export the results.
**Everything runs in your browser. Scans are never uploaded to any server.**

## Features
- **Upload** a MATLAB `.mat` file (v5/v7) by button or drag-and-drop
- **3D view**: original MRI (volume rendering with contrast sliders), root surface, skeleton coloured by root type,
  tips, branch points, water blobs, markers and noise. Every layer can be turned on/off and has its own opacity slider.
- **Automatic analysis**: noise-normalised hysteresis segmentation, removal of markers and detached noise,
  a tube-vs-blob shape filter for water pockets, 3D skeletonisation, and root tracing with main/lateral classification
- **Traits**: number of main and lateral roots, total/main/lateral root length, longest root, rooting depth,
  lateral spread, tips, branch points, root volume, length-by-depth profile, plus a per-root table
- **Correct**: double-click any object to select it, then *Mark as root* / *Mark as non-root*.
  *Erase* and *Add* tools click spheres of root away or in. Undo is available.
- **Compare runs**: save runs with different thresholds and overlay their skeletons in different colours
- **Export (.zip)**: traits CSV (all runs), per-root CSV, JSON (settings + corrections), MATLAB `.mat` volumes,
  RSML architecture file (RootNav, ArchiDART…), a stand-alone interactive 3D HTML page, and a screenshot

## Put it on GitHub Pages (5 minutes)
1. Create a new repository on GitHub (e.g. `root-viewer`). It can be public, or private if your plan supports Pages for private repos.
2. Upload **all files and folders in this folder** to the repository root, keeping the folder structure:
   ```
   index.html
   .nojekyll
   css/style.css
   js/app.js
   js/engine.js
   js/worker.js
   examples/        (optional)
   desktop/         (optional: the desktop Python version)
   README.md
   ```
   On the GitHub website: **Add file → Upload files**, drag the folder contents in, then **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment* choose **Source: Deploy from a branch**,
   **Branch: `main`**, folder **`/ (root)`**, then **Save**.
4. After about a minute your site is live at `https://<your-username>.github.io/<repository-name>/`.

### Optional: a "Load example" button
Put a scan at `examples/example.mat` in the repository. The site detects it and shows a **Load example** button.
GitHub allows files up to 100 MB.

## Run it on your own computer (without GitHub)
Browsers block parts of the app when `index.html` is opened directly from disk, so start a tiny local server:
```
cd root-viewer
python -m http.server 8000
```
Then open <http://localhost:8000>.

## Using it
| Step | What to do |
|---|---|
| 1 · Scan | Upload a file. Choose the variable if the file has several 3D arrays. Set the vertical axis, which end is the plant base, and the voxel size (mm), then press *Reload* if you change them. |
| 2 · Detection | Lower thresholds find fainter roots but more noise. Hover any setting for an explanation. Press **Run analysis**. |
| 3 · Correct | Double-click an object, then **Mark as root / non-root**. Use **Erase / Add** (top-left of the 3D view) with a radius in voxels. |
| 4 · Results | Traits, length-by-depth chart, and a per-root table (click a row to highlight that root). |
| 5 · Compare | **Save current run**, change settings, run again, save again. Tick **Show** to overlay the runs. |
| 6 · Export | Tick what you need and press **Download results (.zip)**. |

Mouse: drag = rotate, scroll = zoom, right-drag = pan. *Spin* turns the view automatically.

Colours: orange = main roots, teal = laterals, purple = detached fragments, blue = water removed,
yellow = tips, grey = markers, red = noise, pink = excluded by you, magenta = selection.

## Notes and limits
- **MATLAB v7.3 files** (HDF5) are not supported in the browser. Re-save in MATLAB with `save('scan.mat','im','-v7')`.
- The first analysis of a scan takes about 10–30 s, because it computes the tube/blob shape maps once. Re-runs take 2–6 s.
- Voxel size defaults to 2 mm in each direction. All lengths scale with it.
- Near the plant base roots touch at MRI resolution, so main-root counts there are estimates. Laterals thinner than a voxel
  are missed, so lateral count and total length are lower bounds. Mean diameter is inflated by partial-volume blur.
- The method is identical to the desktop Python version in `desktop/` (`root_analysis.py`). On the test scan both give the same
  total length, root counts, tips, branch points, volume and water blobs.
- Needs a modern browser with WebGL2 (Chrome, Edge, Firefox, Safari 15+).

## Files
| File | Purpose |
|---|---|
| `index.html`, `css/style.css` | Page layout |
| `js/app.js` | User interface, 3D rendering (three.js), picking, comparison, export |
| `js/engine.js` | The analysis engine (pure JavaScript, no dependencies) |
| `js/worker.js` | Runs the engine in the background so the page stays responsive |
| `desktop/` | Desktop version (Python + napari) and command-line batch analysis |

three.js is loaded from the jsDelivr CDN. Everything else is in this repository.
