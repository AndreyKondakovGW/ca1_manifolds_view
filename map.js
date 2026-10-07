/*
 * 2D "session map" page -- plots data/session_map.json, which export_data.py
 * builds from session_metadata.csv: one record per session that has
 * map_cord1/map_cord2 (a 2D UMAP embedding of the session-by-session manifold
 * distance matrix, written by the pipeline's
 * experiments/src/exp_session_manifold_clustering.py). Clicking a point jumps
 * to index.html with that session pre-selected
 * (index.html?session_type=<type>&session=<name>), read there by app.js.
 *
 * Every session_metadata.csv column except `session`, `map_cord1` and
 * `map_cord2` (and the exporter's own `_`-prefixed bookkeeping fields) is a
 * selectable color feature. How a feature is colored:
 *   - non-numeric (strings, booleans, e.g. session_type, manifold_cluster):
 *     always distinct colors, one legend entry per value;
 *   - numeric with fewer than CATEGORICAL_MAX_UNIQUE distinct values (e.g.
 *     n_groups_after_averaging): distinct colors too;
 *   - numeric with more: a continuous colormap with a colorbar.
 * Sessions with a missing value for the active feature are drawn in grey as
 * their own "missing" legend entry instead of being dropped.
 *
 * A point whose session wasn't part of the last export_data.py run
 * (`_exported` false -- no manifold JSON behind it) is still shown, just not
 * clickable -- clicking it shows a message instead of navigating.
 *
 * Sessions listed in bad_sessions.json ({"bad_sessions": [<session name>,
 * ...]}, next to this file) are left off the map -- read at page load, so
 * editing it only needs a refresh, no re-export. They stay available in the
 * Session dropdown and in index.html's manifold view. A missing/invalid
 * bad_sessions.json just means nothing is excluded.
 *
 * `behavior_score`, if present, uses a sentinel of -1 for sessions with no
 * known score -- since that would otherwise distort the colorscale, a
 * checkbox (shown only while `behavior_score` is the active color feature)
 * lets those sessions be filtered out of the plot.
 *
 * el/showMessage/clearMessage/huslPalette/dropNaUnique come from common.js;
 * huslPalette in turn needs vendor/hsluv.js loaded first.
 */

const X_COLUMN = "map_cord1";
const Y_COLUMN = "map_cord2";
const RESERVED_COLUMNS = new Set(["session", X_COLUMN, Y_COLUMN]);
const DEFAULT_COLOR_FEATURE = "manifold_cluster";
const CATEGORICAL_MAX_UNIQUE = 20;
const MISSING_COLOR = "#b0b0b0";
const BEHAVIOR_SCORE_COLUMN = "behavior_score";
const UNKNOWN_BEHAVIOR_SCORE = -1;

const BAD_SESSIONS_PATH = "bad_sessions.json";

async function loadBadSessions() {
  try {
    const resp = await fetch(BAD_SESSIONS_PATH);
    if (!resp.ok) return new Set();
    const data = await resp.json();
    return new Set((data.bad_sessions || []).map(String));
  } catch (_) {
    return new Set(); // optional file
  }
}

const isMissing = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

const STATE = {
  rows: [],
  colorFeature: null,
  hideUnknownBehaviorScore: true,
};

async function init() {
  el("reload-btn").addEventListener("click", () => location.reload());

  let exportInfo = null;
  try {
    exportInfo = await (await fetch("data/export_info.json")).json();
  } catch (_) {
    // optional
  }
  el("data-source-caption").textContent = exportInfo
    ? `${exportInfo.data_source} (exported ${exportInfo.exported_at})`
    : "data/";

  // Independent of the map below -- session_map.json is very likely a
  // partial view (only sessions someone bothered to embed/cluster), so the
  // dropdown covers every exported session regardless of whether the map
  // has anything to show at all.
  await loadSessionPicker();
  await loadSessionMap();
}

async function loadSessionPicker() {
  let metadata;
  try {
    const resp = await fetch("data/session_metadata.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    metadata = await resp.json();
  } catch (err) {
    return; // no metadata at all -- app.js's own error message covers this on index.html
  }
  if (metadata.length === 0) return;

  // last-wins on a duplicate session name, same convention as app.js
  const labelToRow = new Map();
  for (const row of metadata) labelToRow.set(String(row.session), row);
  const sessionLabels = sortMixed([...labelToRow.keys()]);

  el("sidebar-session-picker").hidden = false;
  el("session-select-label").textContent = `Session (${sessionLabels.length})`;
  const select = el("session-select");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.textContent = "— pick a session —";
  placeholder.value = "";
  select.appendChild(placeholder);
  for (const label of sessionLabels) {
    const opt = document.createElement("option");
    opt.value = label;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.onchange = () => {
    if (!select.value) return;
    const row = labelToRow.get(select.value);
    window.location.href = `index.html?session_type=${encodeURIComponent(row.session_type)}&session=${encodeURIComponent(row.session)}`;
  };
}

async function loadSessionMap() {
  let resp;
  try {
    resp = await fetch("data/session_map.json");
  } catch (err) {
    showMessage(`Failed to fetch data/session_map.json (${err.message}).`, "error");
    return;
  }
  if (!resp.ok) {
    showMessage(
      "No data/session_map.json found. Run the pipeline's experiments/src/exp_session_manifold_clustering.py (adds map_cord1/map_cord2 to session_metadata.csv), then re-run export_data.py (or export_data.py --session-map-only).",
      "error"
    );
    return;
  }
  let rows;
  try {
    rows = await resp.json();
  } catch (err) {
    // file exists (fetch above succeeded) but isn't valid JSON -- see the
    // matching comment in app.js's session_metadata.json handling.
    showMessage(
      `data/session_map.json exists but isn't valid JSON (${err.message}). Check export_data.py's console output for errors and re-run it.`,
      "error"
    );
    return;
  }
  const badSessions = await loadBadSessions();
  const nBefore = rows.length;
  rows = rows.filter((r) => !badSessions.has(String(r.session)));
  STATE.nExcluded = nBefore - rows.length;

  if (rows.length === 0) {
    showMessage(
      nBefore === 0 ? "data/session_map.json is empty." : `All ${nBefore} session(s) on the map are listed in ${BAD_SESSIONS_PATH}.`,
      "warning"
    );
    return;
  }

  STATE.rows = rows;
  el("sidebar-map-options").hidden = false;

  // union over all rows -- a column can be null/absent on some records
  const featureCols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    .filter((k) => !RESERVED_COLUMNS.has(k) && !k.startsWith("_"));
  const select = el("color-select");
  select.innerHTML = "";
  for (const col of featureCols) {
    const opt = document.createElement("option");
    opt.value = col;
    opt.textContent = col;
    select.appendChild(opt);
  }
  STATE.colorFeature = featureCols.includes(DEFAULT_COLOR_FEATURE) ? DEFAULT_COLOR_FEATURE : (featureCols[0] || null);
  select.value = STATE.colorFeature || "";
  select.onchange = () => {
    STATE.colorFeature = select.value;
    render();
  };

  el("hide-unknown-behavior-score").addEventListener("change", (e) => {
    STATE.hideUnknownBehaviorScore = e.target.checked;
    render();
  });

  render();
}

// Distinct-color order: numbers ascending, everything else as strings with
// natural-number ordering (so cluster_2 comes before cluster_10).
function sortCategories(values) {
  if (values.every((v) => typeof v === "number")) return [...values].sort((a, b) => a - b);
  return [...values].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function render() {
  const feature = STATE.colorFeature;
  const isBehaviorScore = feature === BEHAVIOR_SCORE_COLUMN;
  el("behavior-score-options").hidden = !isBehaviorScore;

  const rows = (isBehaviorScore && STATE.hideUnknownBehaviorScore)
    ? STATE.rows.filter((r) => r[BEHAVIOR_SCORE_COLUMN] !== UNKNOWN_BEHAVIOR_SCORE)
    : STATE.rows;
  const colorValues = feature ? rows.map((r) => r[feature]) : rows.map(() => null);
  const uniqueVals = dropNaUnique(colorValues);
  const numeric = uniqueVals.length > 0 && uniqueVals.every((v) => typeof v === "number");
  const categorical = !numeric || uniqueVals.length < CATEGORICAL_MAX_UNIQUE;

  const hoverText = (j) => {
    const r = rows[j];
    const value = isMissing(colorValues[j]) ? "missing" : colorValues[j];
    const note = r._exported ? "" : "<br>(no manifold data exported)";
    return `${r.session} (${r.session_type})<br>${feature} = ${value}${note}`;
  };
  const makeTrace = (idx, marker, name) => ({
    x: idx.map((j) => rows[j][X_COLUMN]),
    y: idx.map((j) => rows[j][Y_COLUMN]),
    mode: "markers",
    type: "scattergl",
    marker: { size: 9, line: { width: 0 }, ...marker },
    text: idx.map(hoverText),
    customdata: idx,
    name,
    hovertemplate: "%{text}<extra></extra>",
  });

  const traces = [];
  const presentIdx = [];
  const missingIdx = [];
  colorValues.forEach((v, j) => (isMissing(v) ? missingIdx : presentIdx).push(j));

  if (categorical) {
    const order = sortCategories(uniqueVals);
    const colors = huslPalette(order.length);
    order.forEach((cat, i) => {
      const idx = presentIdx.filter((j) => colorValues[j] === cat);
      traces.push(makeTrace(idx, { color: colors[i] }, String(cat)));
    });
  } else if (presentIdx.length) {
    traces.push(makeTrace(presentIdx, {
      color: presentIdx.map((j) => colorValues[j]),
      colorscale: "Viridis",
      colorbar: { title: { text: feature } },
    }, feature));
  }
  if (missingIdx.length) {
    traces.push(makeTrace(missingIdx, { color: MISSING_COLOR }, "missing"));
  }

  const layout = {
    autosize: true,
    height: 700,
    margin: { l: 50, r: 20, b: 50, t: 20 },
    xaxis: { title: { text: X_COLUMN } },
    yaxis: { title: { text: Y_COLUMN } },
    // in colormap mode the legend only has the "missing" entry, if any
    showlegend: categorical || missingIdx.length > 0,
    legend: { title: { text: feature || "" } },
  };

  Plotly.newPlot("plot", traces, layout, { responsive: true }).then((gd) => {
    gd.on("plotly_click", (data) => {
      const row = rows[data.points[0].customdata];
      clearMessage();
      if (row._exported) {
        window.location.href = `index.html?session_type=${encodeURIComponent(row.session_type)}&session=${encodeURIComponent(row.session)}`;
      } else {
        showMessage(
          `No exported manifold data for "${row.session}" -- it wasn't part of the last export_data.py run.`,
          "warning"
        );
      }
    });
  });

  const nClickable = rows.filter((r) => r._exported).length;
  const mode = categorical ? "distinct colors" : "colormap";
  const excludedNote = STATE.nExcluded ? ` (${STATE.nExcluded} excluded via bad_sessions.json)` : "";
  el("caption").textContent = `${rows.length} session(s)${excludedNote}, ${nClickable} with manifold data available -- colored by ${feature} (${mode}). Click a point to open its manifold view.`;
}

init();
