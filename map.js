/*
 * 2D "session map" page -- plots data/session_map.json, which export_data.py
 * builds from session_metadata.csv: one record per session that has
 * map_cord1/map_cord2 (a 2D UMAP embedding of the session-by-session manifold
 * distance matrix, written by the pipeline's
 * experiments/src/exp_session_manifold_clustering.py). Clicking a point jumps
 * to index.html with that session pre-selected
 * (index.html?session_type=<type>&session=<name>), read there by app.js.
 *
 * Session features live in several metadata tables (session_metadata.csv
 * main, averaging_, decoding_ and behavioural_metadata.csv -- the pipeline's
 * src/add_session_features/metadata_tables.py); export_data.py joins them
 * into session_map.json and lists which column came from which table in
 * data/feature_tables.json. The sidebar picks a "Feature table" first, then
 * one of its columns as the color feature (default: manifold_cluster); the
 * "Filter by" dropdown groups its columns by table the same way. Without
 * feature_tables.json (older export) all columns form one group. Every
 * column except `session`, `map_cord1` and `map_cord2` (and the exporter's
 * own `_`-prefixed bookkeeping fields) is selectable. How a feature is
 * colored:
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
 * `behavior score` (`behavior_score` in older exports) may use a sentinel of
 * -1 for sessions with no known score -- since that would otherwise distort
 * the colorscale, a checkbox (shown only while that column is the active
 * color feature and some session has -1) lets those sessions be filtered out
 * of the plot.
 *
 * The page's Session picker (independent of the map) is animal first: the
 * session dropdown lists only the chosen animal's sessions (animalOf in
 * common.js).
 *
 * Independently of coloring, the "Filter by" dropdown restricts which points
 * are drawn to chosen values of one categorical feature (any column with
 * fewer than FILTER_MAX_UNIQUE distinct non-missing values; "missing" is its
 * own option when present). Values are checkboxes -- none checked means no
 * filtering. The color mapping (category -> color, colormap range) is always
 * computed on the unfiltered rows, so a category keeps the same color and the
 * colorscale the same range whichever filter is active -- that is what makes
 * comparing a feature's color distribution within one filter category
 * meaningful.
 *
 * Sidebar choices (feature table, color feature, filter feature and its
 * checked values, the hide-unknown-score box) are saved to localStorage on
 * every render and restored on load (keys in common.js), so they survive
 * switching to index.html and back. The Session picker starts on the animal /
 * session last chosen in index.html (read from that page's saved settings).
 *
 * el/showMessage/clearMessage/huslPalette/dropNaUnique come from common.js;
 * huslPalette in turn needs vendor/hsluv.js loaded first.
 */

const X_COLUMN = "map_cord1";
const Y_COLUMN = "map_cord2";
const RESERVED_COLUMNS = new Set(["session", X_COLUMN, Y_COLUMN]);
const DEFAULT_COLOR_FEATURE = "manifold_cluster";
const CATEGORICAL_MAX_UNIQUE = 30;
const FILTER_MAX_UNIQUE = 30;
const MISSING_KEY = "__missing__";
const MISSING_COLOR = "#b0b0b0";
// old export name / current behavioural_metadata.csv name
const BEHAVIOR_SCORE_COLUMNS = new Set(["behavior_score", "behavior score"]);
const UNKNOWN_BEHAVIOR_SCORE = -1;

const BAD_SESSIONS_PATH = "bad_sessions.json";
const FEATURE_TABLES_PATH = "data/feature_tables.json";

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
  tables: {},                // {table name: [columns]}, see loadFeatureTables
  colorFeature: null,
  filterFeature: "",          // "" = no filter
  filterSelected: new Set(),  // filterKey()s of the values to keep; empty = keep all
  hideUnknownBehaviorScore: true,
};

// localStorage settings of this page (see the module docstring)
const SAVED = loadSettings(SETTINGS_KEYS.map);

function saveMapState() {
  saveSettings(SETTINGS_KEYS.map, {
    table: el("table-select").value,
    colorFeature: STATE.colorFeature,
    filterFeature: STATE.filterFeature,
    filterSelected: [...STATE.filterSelected],
    hideUnknownBehaviorScore: STATE.hideUnknownBehaviorScore,
  });
}

async function init() {
  el("reload-btn").addEventListener("click", () => {
    clearSettings(); // also forget the remembered sidebar choices
    location.reload();
  });

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

  // animal first, then that animal's sessions
  const animalCounts = new Map();
  for (const row of metadata) animalCounts.set(animalOf(row), (animalCounts.get(animalOf(row)) || 0) + 1);
  const animals = sortMixed([...animalCounts.keys()]);

  el("sidebar-session-picker").hidden = false;
  el("animal-select-label").textContent = `Animal (${animals.length})`;
  const animalSelect = el("animal-select");
  const viewer = loadSettings(SETTINGS_KEYS.viewer); // the manifold viewer's current animal / session
  fillSelect(animalSelect, animals, {
    placeholder: "— pick an animal —",
    selected: animalCounts.has(viewer.selectedAnimal) ? viewer.selectedAnimal : null,
    labels: (a) => `${a} (${animalCounts.get(a)})`,
  });

  // last-wins on a duplicate session name, same convention as app.js
  const labelToRow = new Map();
  const select = el("session-select");
  const fillSessions = () => {
    labelToRow.clear();
    for (const row of metadata) {
      if (animalOf(row) === animalSelect.value) labelToRow.set(String(row.session), row);
    }
    const sessionLabels = sortMixed([...labelToRow.keys()]);
    el("session-select-label").textContent = `Session (${sessionLabels.length})`;
    fillSelect(select, sessionLabels, {
      placeholder: animalSelect.value ? "— pick a session —" : "— pick an animal first —",
      selected: labelToRow.has(viewer.selectedSession) ? viewer.selectedSession : null,
    });
    select.disabled = !animalSelect.value;
  };
  animalSelect.onchange = fillSessions;
  fillSessions();
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
  STATE.tables = await loadFeatureTables(featureCols);

  const tableSelect = el("table-select");
  const tableNames = Object.keys(STATE.tables);
  fillSelect(tableSelect, tableNames, { labels: (t) => `${tableLabel(t)} (${STATE.tables[t].length})` });
  const defaultTable = tableNames.includes(SAVED.table) && STATE.tables[SAVED.table].includes(SAVED.colorFeature)
    ? SAVED.table
    : (tableNames.find((t) => STATE.tables[t].includes(DEFAULT_COLOR_FEATURE)) || tableNames[0]);
  tableSelect.value = defaultTable || "";
  tableSelect.onchange = () => {
    fillColorSelect(tableSelect.value, null);
    render();
  };
  fillColorSelect(defaultTable, defaultTable === SAVED.table ? SAVED.colorFeature : DEFAULT_COLOR_FEATURE);

  if (typeof SAVED.hideUnknownBehaviorScore === "boolean") STATE.hideUnknownBehaviorScore = SAVED.hideUnknownBehaviorScore;
  el("hide-unknown-behavior-score").checked = STATE.hideUnknownBehaviorScore;
  setupFilterSelect(featureCols);

  el("hide-unknown-behavior-score").addEventListener("change", (e) => {
    STATE.hideUnknownBehaviorScore = e.target.checked;
    render();
  });

  render();
}

// {table name: [columns]} from data/feature_tables.json (export_data.py),
// restricted to columns actually in session_map.json; columns no table claims
// go to an "other" group. Without the file (older export) every column is in
// one "all features" group.
async function loadFeatureTables(featureCols) {
  let tables = {};
  try {
    const resp = await fetch(FEATURE_TABLES_PATH);
    if (resp.ok) tables = await resp.json();
  } catch (_) {
    // optional file
  }
  const present = new Set(featureCols);
  const out = {};
  const claimed = new Set();
  for (const [name, cols] of Object.entries(tables)) {
    const kept = cols.filter((c) => present.has(c) && !claimed.has(c));
    kept.forEach((c) => claimed.add(c));
    if (kept.length) out[name] = kept;
  }
  const rest = featureCols.filter((c) => !claimed.has(c));
  if (rest.length) out[Object.keys(out).length ? "other" : "all features"] = rest;
  return out;
}

// "decoding_metadata" -> "decoding"
const tableLabel = (name) => name.replace(/_metadata$/, "");

function fillColorSelect(table, preferred) {
  const cols = STATE.tables[table] || [];
  const select = el("color-select");
  STATE.colorFeature = cols.includes(preferred) ? preferred : (cols[0] || null);
  fillSelect(select, cols, { selected: STATE.colorFeature });
  select.onchange = () => {
    STATE.colorFeature = select.value;
    render();
  };
}

// String key for a filter value -- checkbox state is keyed by this so that
// e.g. 1 and "1" or missing (null/NaN) values compare predictably.
const filterKey = (v) => (isMissing(v) ? MISSING_KEY : `${typeof v}:${v}`);

function setupFilterSelect(featureCols) {
  const filterCols = featureCols.filter((col) => {
    const n = dropNaUnique(STATE.rows.map((r) => r[col])).length;
    return n > 0 && n < FILTER_MAX_UNIQUE;
  });
  if (SAVED.filterFeature && filterCols.includes(SAVED.filterFeature)) {
    STATE.filterFeature = SAVED.filterFeature;
    // keep only values that still exist, so a stale choice can't hide every point
    const present = new Set(STATE.rows.map((r) => filterKey(r[SAVED.filterFeature])));
    STATE.filterSelected = new Set((SAVED.filterSelected || []).filter((k) => present.has(k)));
  }
  const select = el("filter-select");
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— no filter —";
  select.appendChild(none);
  // one <optgroup> per metadata table, same grouping as the color picker
  for (const [table, cols] of Object.entries(STATE.tables)) {
    const groupCols = cols.filter((c) => filterCols.includes(c));
    if (!groupCols.length) continue;
    const group = document.createElement("optgroup");
    group.label = tableLabel(table);
    for (const col of groupCols) {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }
  select.value = STATE.filterFeature;
  select.onchange = () => {
    STATE.filterFeature = select.value;
    STATE.filterSelected = new Set();
    renderFilterValues();
    render();
  };
  renderFilterValues();
}

function renderFilterValues() {
  const col = STATE.filterFeature;
  el("filter-values-wrap").hidden = !col;
  const box = el("filter-values");
  box.innerHTML = "";
  if (!col) return;

  const values = STATE.rows.map((r) => r[col]);
  const options = sortCategories(dropNaUnique(values));
  if (values.some(isMissing)) options.push(null);
  for (const v of options) {
    const key = filterKey(v);
    const count = values.filter((x) => filterKey(x) === key).length;
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = STATE.filterSelected.has(key);
    cb.addEventListener("change", () => {
      if (cb.checked) STATE.filterSelected.add(key);
      else STATE.filterSelected.delete(key);
      render();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`${isMissing(v) ? "missing" : v} (${count})`));
    box.appendChild(label);
  }
}

// Distinct-color order: numbers ascending, everything else as strings with
// natural-number ordering (so cluster_2 comes before cluster_10).
function sortCategories(values) {
  if (values.every((v) => typeof v === "number")) return [...values].sort((a, b) => a - b);
  return [...values].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function render() {
  saveMapState();
  const feature = STATE.colorFeature;
  const isBehaviorScore = BEHAVIOR_SCORE_COLUMNS.has(feature)
    && STATE.rows.some((r) => r[feature] === UNKNOWN_BEHAVIOR_SCORE);
  el("behavior-score-options").hidden = !isBehaviorScore;

  const colorRows = (isBehaviorScore && STATE.hideUnknownBehaviorScore)
    ? STATE.rows.filter((r) => r[feature] !== UNKNOWN_BEHAVIOR_SCORE)
    : STATE.rows;
  // Color mapping comes from colorRows (pre-filter) so it doesn't shift when
  // the filter changes -- see the module docstring.
  const allColorValues = feature ? colorRows.map((r) => r[feature]) : colorRows.map(() => null);
  const uniqueVals = dropNaUnique(allColorValues);
  const numeric = uniqueVals.length > 0 && uniqueVals.every((v) => typeof v === "number");
  const categorical = !numeric || uniqueVals.length < CATEGORICAL_MAX_UNIQUE;

  const filterCol = STATE.filterFeature;
  const filterActive = Boolean(filterCol) && STATE.filterSelected.size > 0;
  const rows = filterActive
    ? colorRows.filter((r) => STATE.filterSelected.has(filterKey(r[filterCol])))
    : colorRows;
  const colorValues = rows.map((r) => (feature ? r[feature] : null));

  const hoverText = (j) => {
    const r = rows[j];
    const value = isMissing(colorValues[j]) ? "missing" : colorValues[j];
    const note = r._exported ? "" : "<br>(no manifold data exported)";
    const filterNote = filterCol && filterCol !== feature
      ? `<br>${filterCol} = ${isMissing(r[filterCol]) ? "missing" : r[filterCol]}`
      : "";
    return `${r.session} (${r.session_type})<br>${feature} = ${value}${filterNote}${note}`;
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
      if (idx.length === 0) return; // category absent under the current filter
      traces.push(makeTrace(idx, { color: colors[i] }, String(cat)));
    });
  } else if (presentIdx.length) {
    traces.push(makeTrace(presentIdx, {
      color: presentIdx.map((j) => colorValues[j]),
      colorscale: "Viridis",
      cmin: Math.min(...uniqueVals),
      cmax: Math.max(...uniqueVals),
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
  const filterNote = filterActive
    ? ` [filtered: ${filterCol} in {${[...STATE.filterSelected].map((k) => (k === MISSING_KEY ? "missing" : k.slice(k.indexOf(":") + 1))).join(", ")}}, ${rows.length}/${colorRows.length} shown]`
    : "";
  el("caption").textContent = `${rows.length} session(s)${excludedNote}${filterNote}, ${nClickable} with manifold data available -- colored by ${feature} (${mode}). Click a point to open its manifold view.`;
}

init();
