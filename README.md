# CA1 manifold viewer (GitHub Pages) Claude made

A static, GitHub-Pages-friendly viewer for CA1 manifold data -- pick a
session, view its full or averaged manifold, color/filter it, or browse a
2D map of every session -- adapted from an internal Streamlit prototype
(not included in this repo) into plain HTML/CSS/JS + Plotly.js, so it can be
hosted for free with no Python backend.

## Requirements

This repo is two things bundled together:

- **The published site** (`index.html`, `sessions_map.html`, `app.js`,
  `map.js`, `common.js`, `style.css`, `config.json`, `vendor/`, `data/`) --
  fully static, no dependencies beyond a web server. This is what actually
  gets hosted.
- **`export_data.py`**, the local build step that (re)generates `data/` from
  a source manifold folder (NWB + CSV files from an upstream CA1
  manifold-building pipeline). This script is *not* standalone: it imports
  `geodesic_distance_matrix` from that pipeline's `src/manifold_dist.py` and
  reads NWB files via `pynapple`/`pynwb`, so it only runs from inside a
  checkout of that pipeline (with a Python environment providing pynapple,
  pynwb, numpy, pandas, scipy, scikit-learn, and PyYAML). If you don't have
  that pipeline checkout, you can still run the published site as-is --
  `data/` already ships populated -- you just can't regenerate it yourself.

## Setup

1. Edit `export_config.yaml` -- set `manifold_folder` to your processed
   output root, and optionally an allowlist of sessions to export
   (`sessions:`) if you don't want the whole folder turned into JSON. If you
   also have a 2D "session map" table (see `sessions_map.html` below), point
   `session_map_csv` at it too.
2. Run the exporter (see Requirements above for what it needs):

   ```
   python export_data.py
   ```

   This (re)writes `data/`. Re-run it any time the source manifold folder
   changes.

   > `data/` ships pre-populated so the site works out of the box -- step 1
   > above replaces it with your own data.

3. Preview locally -- `fetch()` needs an HTTP server, opening `index.html`
   directly (`file://`) won't load the data:

   ```
   python -m http.server 8000
   ```

   then open `http://localhost:8000`.

4. Publish to GitHub Pages: push this repo to GitHub and point Pages at it
   (Settings > Pages > "Deploy from a branch", branch = your default
   branch, folder = `/` (root)). No build step is needed; it's already
   plain static files.

## What it does

- **Sidebar > Session** -- loads `data/session_metadata.json` and lists every
  exported session in a dropdown, filterable by `session_type`,
  `n_groups_after_averaging`, and `manifold_cluster` (each filter only
  appears if that column exists in your metadata, and each filter's option
  list narrows based on the ones above it).
- **Sidebar > View > Full manifold** -- plots the selected session's full
  per-bin manifold, colored by position, speed, or time, restricted to the
  `maze_group`(s) chosen in the sidebar (`N2N`/`F2F`/`N2F`/`F2N`).
- **Sidebar > View > Averaged manifold** -- plots the `_avg.csv` data instead
  (one averaged trajectory per `maze_group` cluster), colored by `Group`.
- **Sidebar > View > Geodesic matrix** -- heatmap of the pairwise geodesic
  distance between the averaged manifold's own points (computed once by
  `export_data.py`, since it's too slow to run per-click in a browser, and
  stored per session as `geodesic_matrix` in that session's JSON).

Sessions with no `manifold` acquisition (stage 2 not run yet) or no
averaged-manifold CSV show a message instead of a plot.

- **`sessions_map.html`** (linked from the top of `index.html`) -- a
  separate page: a 2D scatter of `data/session_map.json` (from a
  `session_map_csv` table you point `export_config.yaml` at -- session name
  as the index/first column, then `UMAP1`, `UMAP2`, plus any number of extra
  columns to color by, e.g. a cluster label). Click a point to jump straight
  to that session's manifold view in `index.html`. A session map is very
  likely a partial view (only whatever sessions someone happened to
  embed/cluster), so the page also keeps its own **Session** dropdown --
  every exported session, independent of what's plotted below -- and a
  point for a session that wasn't part of the last `export_data.py` run (no
  matching entry in `session_metadata.json`) still shows on the map, just
  isn't clickable.

## Notes

- `config.json` (client-side settings: point size, plot height, default
  color feature, etc.) is fetched by the page at runtime -- edit it and
  refresh, no rebuild needed. It's separate from `export_config.yaml`, which
  only controls what `export_data.py` reads/writes and isn't fetched by the
  page itself.
- "Clear cache & reload" just reloads the page (a static site has no
  server-side cache to clear) -- use it after re-running `export_data.py`
  and re-deploying.
- **Geodesic matrix block boundaries are derived from the data, not
  hardcoded.** Block boundaries come from the actual contiguous runs of
  `Group` in the averaged manifold, so a session with more than 4 averaged
  groups still renders correctly.
- The geodesic matrix is by far the biggest thing in a session's JSON (an
  N x N table for N averaged-manifold points) -- lower `round_decimals` in
  `export_config.yaml` if exported file size becomes a problem for a large
  batch of sessions.
- `sessions_map.html` uses `scattergl` (WebGL) rather than `app.js`'s
  `scatter3d` -- fine for however many sessions you're likely to have.
- **Session map colors come from HSLuv ("husl"), not a fixed 10-color
  palette.** `common.js`'s `huslPalette(n)` generates `n` evenly-spaced hues
  via `vendor/hsluv.js` (a vendored, unminified copy of the
  [hsluv-js](https://github.com/hsluv/hsluv-js) reference implementation,
  MIT license), so a categorical color-by feature with many distinct values
  never repeats a color. Only `sessions_map.html` loads `vendor/hsluv.js`.
- `session_map_csv`/`data/session_map.json` are entirely optional and
  independent of everything else here -- if unset, `sessions_map.html` just
  shows a "not available" message (its session dropdown still works, since
  that only needs `session_metadata.json`) and `index.html` is unaffected.
- `data/export_info.json`'s `data_source` field (shown in the sidebar) is a
  short label, never the absolute local `manifold_folder` path -- see
  `data_source_label` in `export_config.yaml` if you want to override it.
