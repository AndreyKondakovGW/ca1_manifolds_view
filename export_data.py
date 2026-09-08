"""
Export a manifold folder (NWB + CSV files produced by an upstream CA1
manifold-building pipeline, stages 1-3) into the static JSON files consumed
by this folder's index.html/app.js -- i.e. turns that pipeline's per-session
output into a static site that GitHub Pages (or any static file host) can
serve, with no Python backend at request time.

Requirements: this script is a local build step, not part of the published
site, and it is NOT standalone -- it imports `geodesic_distance_matrix` from
that upstream pipeline's `src/manifold_dist.py` and uses `pynapple`/`pynwb`
to read the pipeline's NWB files. Run it from inside a checkout of that
pipeline (with this folder present as one of its subfolders, so `src/` is a
sibling directory -- REPO_ROOT below resolves one level up from this file)
and with its Python environment active (pynapple, pynwb, numpy, pandas,
scipy, scikit-learn, PyYAML). Only the *output* -- this repo's data/ folder
plus the rest of the static site -- needs to travel with the published repo.

Reads this layout:
    MANIFOLD_FOLDER/session_metadata.csv
    MANIFOLD_FOLDER/<session_type>/<session>.nwb
    MANIFOLD_FOLDER/<session_type>/<session>_avg.csv

and writes:
    data/session_metadata.json
    data/export_info.json  (a short data-source label + export timestamp,
        shown in the site's "Data source" sidebar caption -- never the
        absolute local manifold_folder path, see `data_source_label` below)
    data/<session_type>/<session>.json
        {
          "laps": {"start": [...], "end": [...], "maze_group": [...]},
          "manifold": {"t": [...], "UMAP1": [...], "UMAP2": [...],
                       "UMAP3": [...], "position": [...], "speed": [...]}
                      or null if the NWB file has no "manifold" acquisition
                      (stage 2 wasn't run for it),
          "avg": {"UMAP_1": [...], "UMAP_2": [...], "UMAP_3": [...],
                  "Group": [...], "position_bin": [...]}
                 or null if the session has no <session>_avg.csv (or it's
                 empty / missing the "Group" column),
          "geodesic_matrix": [[...], ...]  (NxN, N = len(avg's rows) -- pairwise
                 geodesic distance between the averaged-manifold points, from
                 src/manifold_dist.py's geodesic_distance_matrix run on the
                 same UMAP_1/2/3 coordinates as "avg") or null if "avg" is null
        }

If export_config.yaml's `session_map_csv` is set, also writes:
    data/session_map.json  -- one record per row of that CSV:
        {"session": <index/first column>, "UMAP1": ..., "UMAP2": ...,
        <every other column in the CSV, used as selectable color features
        by sessions_map.html>..., "session_type": <resolved from
        session_metadata.csv if this session was actually exported, else
        null>}. Powers the separate sessions_map.html page (a 2D plot of all
        sessions; click a point to jump to that session's manifold view --
        only possible when "session_type" isn't null).

Settings live in export_config.yaml next to this file (manifold folder path,
output dir, optional session allowlist, rounding) -- edit that, no code
changes needed.

    python export_data.py
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yaml
from pynwb import NWBHDF5IO

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import pynapple as nap
from src.manifold_dist import geodesic_distance_matrix

CONFIG_PATH = Path(__file__).resolve().parent / "export_config.yaml"


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def _json_safe(v):
    """NaN isn't valid JSON -- json.dump would emit a literal `NaN` token
    that breaks JSON.parse()/fetch().json() in every browser, so replace it
    with null. (kept.where(pd.notnull(kept), None), the previous approach,
    looked like it should already do this but doesn't: a None assigned into
    a float64 column is silently coerced right back to NaN by pandas, so
    any all-numeric column's NaNs survived all the way into the JSON file.
    Checking each already-to_dict()'d value directly, as done here, isn't
    subject to that per-column dtype gotcha.)"""
    if isinstance(v, float) and np.isnan(v):
        return None
    return v


def _round(values, decimals):
    arr = np.asarray(values, dtype=float)
    if decimals is not None:
        arr = np.round(arr, decimals)
    # NaN isn't valid JSON -- json.dump would emit a literal `NaN` token that
    # most JS JSON parsers choke on, so store it as null instead.
    return [None if np.isnan(v) else float(v) for v in arr]


def load_laps(nwb):
    data = nap.NWBFile(nwb)
    laps = data["laps"]
    return {
        "start": _round(laps.start, None),
        "end": _round(laps.end, None),
        "maze_group": [str(g) for g in laps.get_info("maze_group")],
    }


def load_manifold(nwb, decimals):
    if "manifold" not in nwb.acquisition:
        return None
    ts = nwb.acquisition["manifold"]
    t = np.asarray(ts.timestamps[:], dtype=float)
    d = np.asarray(ts.data[:], dtype=float)
    # Column order matches the upstream pipeline's "manifold" NWB
    # acquisition: UMAP1, UMAP2, UMAP3, position, speed.
    return {
        "t": _round(t, decimals),
        "UMAP1": _round(d[:, 0], decimals),
        "UMAP2": _round(d[:, 1], decimals),
        "UMAP3": _round(d[:, 2], decimals),
        "position": _round(d[:, 3], decimals),
        "speed": _round(d[:, 4], decimals),
    }


def load_avg(avg_path, decimals):
    """Returns (avg_json, avg_df) -- avg_df (the raw, unrounded dataframe) is
    handed to compute_geodesic_matrix separately, since that needs full
    float precision and its own (much coarser) rounding of the result."""
    if not avg_path.exists():
        return None, None
    try:
        df = pd.read_csv(avg_path)
    except pd.errors.EmptyDataError:
        # a handful of real _avg.csv files on disk are truly empty (0 bytes,
        # not even a header row) -- pd.read_csv can't even build an empty
        # dataframe from those, so treat it the same as "no avg data" below.
        return None, None
    if df.empty or "Group" not in df.columns:
        return None, None
    avg_json = {
        "UMAP_1": _round(df["UMAP_1"], decimals),
        "UMAP_2": _round(df["UMAP_2"], decimals),
        "UMAP_3": _round(df["UMAP_3"], decimals),
        "Group": [str(g) for g in df["Group"]],
    }
    if "position_bin" in df.columns:
        avg_json["position_bin"] = _round(df["position_bin"], decimals)
    return avg_json, df


def compute_geodesic_matrix(avg_df, decimals):
    """Pairwise geodesic distance between an averaged manifold's own points
    (src/manifold_dist.py's geodesic_distance_matrix on the same UMAP_1/2/3
    coordinates plotted by the "Averaged manifold" view), as a plain nested
    list ready for JSON. None if there's nothing to compute it from."""
    if avg_df is None or len(avg_df) < 2:
        return None
    X = avg_df[["UMAP_1", "UMAP_2", "UMAP_3"]].fillna(0).to_numpy(dtype=float)
    matrix = geodesic_distance_matrix(X)
    if decimals is not None:
        matrix = np.round(matrix, decimals)
    # inf can show up if a point never gets connected into the kNN graph;
    # not valid JSON, so store it as null like other missing values.
    return [
        [None if (np.isnan(v) or np.isinf(v)) else float(v) for v in row]
        for row in matrix
    ]


def load_session_map(session_map_csv):
    """session_map_csv: session name as the index/first column, then UMAP1,
    UMAP2, plus any number of extra columns used as selectable color
    features by sessions_map.html (e.g. a cluster label). Returns None
    (nothing to export) if the setting is blank or the file doesn't exist
    or is missing UMAP1/UMAP2."""
    if not session_map_csv:
        return None
    path = Path(session_map_csv)
    if not path.is_absolute():
        path = (REPO_ROOT / path).resolve()
    if not path.exists():
        print(f"session_map_csv is set to {path} but that file doesn't exist -- skipping session map export.")
        return None
    df = pd.read_csv(path, index_col=0)
    missing = {"UMAP1", "UMAP2"} - set(df.columns)
    if missing:
        print(f"session_map_csv at {path} is missing required column(s) {missing} -- skipping session map export.")
        return None
    return df


def export_session_map(session_map_df, output_dir, decimals, session_type_by_name):
    """session_type_by_name: {session_name: session_type} for sessions that
    were actually exported this run (last-wins on a duplicate name, same
    convention as the session dropdown in app.js) -- lets the map tell
    sessions_map.html which points are clickable and where they link to."""
    records = []
    for session_name, row in session_map_df.iterrows():
        record = {"session": str(session_name)}
        for col in session_map_df.columns:
            v = row[col]
            if pd.isna(v):
                record[col] = None
            elif col in ("UMAP1", "UMAP2") or isinstance(v, (int, float, np.integer, np.floating)):
                record[col] = round(float(v), decimals) if decimals is not None else float(v)
            else:
                record[col] = str(v)
        record["session_type"] = session_type_by_name.get(str(session_name))
        records.append(record)
    with open(output_dir / "session_map.json", "w") as f:
        json.dump(records, f)
    n_clickable = sum(1 for r in records if r["session_type"] is not None)
    print(f"Wrote session_map.json: {len(records)} session(s), {n_clickable} with a matching exported session_type.")


def export_session(manifold_folder, session_type, session_name, output_dir, decimals):
    nwb_path = manifold_folder / session_type / f"{session_name}.nwb"
    avg_path = manifold_folder / session_type / f"{session_name}_avg.csv"

    if not nwb_path.exists():
        print(f"  ! skipping {session_type}/{session_name}: missing NWB file {nwb_path}")
        return False

    avg_json, avg_df = load_avg(avg_path, decimals)
    with NWBHDF5IO(str(nwb_path), "r", load_namespaces=True) as io:
        nwb = io.read()
        session_json = {
            "laps": load_laps(nwb),
            "manifold": load_manifold(nwb, decimals),
            "avg": avg_json,
            "geodesic_matrix": compute_geodesic_matrix(avg_df, decimals),
        }

    out_path = output_dir / session_type / f"{session_name}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(session_json, f)
    return True


def main():
    config = load_config()
    manifold_folder = Path(config["manifold_folder"])
    if not manifold_folder.is_absolute():
        manifold_folder = (REPO_ROOT / manifold_folder).resolve()
    output_dir = Path(__file__).resolve().parent / config.get("output_dir", "data")
    decimals = config.get("round_decimals", 4)
    session_allowlist = set(config.get("sessions") or [])

    metadata_path = manifold_folder / "session_metadata.csv"
    if not metadata_path.exists():
        print(f"No session_metadata.csv found in {manifold_folder} -- check "
              f"manifold_folder in export_config.yaml.")
        sys.exit(1)

    metadata = pd.read_csv(metadata_path)
    if session_allowlist:
        keep = metadata.apply(lambda r: f"{r['session_type']}/{r['session']}" in session_allowlist, axis=1)
        metadata = metadata[keep]

    session_map_df = load_session_map(config.get("session_map_csv"))

    output_dir.mkdir(parents=True, exist_ok=True)

    exported_rows = []
    print(f"Exporting {len(metadata)} session(s) from {manifold_folder} to {output_dir}")
    for row in metadata.itertuples():
        try:
            ok = export_session(manifold_folder, row.session_type, row.session, output_dir, decimals)
        except Exception as e:
            # one session's bad/corrupt data (unreadable NWB, malformed CSV,
            # ...) shouldn't take down the whole batch -- log it and move on.
            print(f"  ! error exporting {row.session_type}/{row.session}: {e}")
            ok = False
        print(f"  {'ok' if ok else 'FAILED'}: {row.session_type}/{row.session}")
        if ok:
            exported_rows.append(row)

    # session_metadata.json only lists sessions that were actually exported,
    # so the site never offers a session with no data file behind it.
    kept = pd.DataFrame(exported_rows).drop(columns=["Index"], errors="ignore") if exported_rows else metadata.iloc[0:0]
    records = [{k: _json_safe(v) for k, v in row.items()} for row in kept.to_dict(orient="records")]
    with open(output_dir / "session_metadata.json", "w") as f:
        json.dump(records, f)

    # Never write the absolute local manifold_folder path -- it can (and did,
    # for a real user of this script) contain a personal folder name that
    # has no business ending up in a published repo. data_source_label lets
    # that be overridden explicitly; otherwise it falls back to just the
    # folder's own last path component (e.g. "sessions_processed").
    data_source_label = config.get("data_source_label") or manifold_folder.name
    with open(output_dir / "export_info.json", "w") as f:
        json.dump({
            "data_source": data_source_label,
            "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        }, f)

    if session_map_df is not None:
        # last-wins on a duplicate session name, in exported-row order --
        # same convention as the session dropdown in app.js
        session_type_by_name = {str(r.session): r.session_type for r in exported_rows}
        export_session_map(session_map_df, output_dir, decimals, session_type_by_name)

    print(f"Done. {len(exported_rows)}/{len(metadata)} session(s) exported.")


if __name__ == "__main__":
    main()
