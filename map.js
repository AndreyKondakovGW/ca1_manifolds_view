/*
 * 2D "session map" page -- plots data/session_map.json (exported by
 * export_data.py from a `session_map_csv` table: session name as the
 * index/first column, then UMAP1, UMAP2, plus any number of extra columns
 * used as selectable color features, e.g. a cluster label). Clicking a
 * point jumps to index.html with that session pre-selected
 * (index.html?session_type=<type>&session=<name>), read there by app.js.
 *
 * A point whose session wasn't part of the last export_data.py run (not in
 * session_metadata.json, so there's no manifold data behind it) has no
 * `session_type` and is still shown, just not clickable -- clicking it shows
 * a message instead of navigating.
 *
 * Any column beyond the reserved ones (e.g. `session_cluster`, `session_type`,
 * `behavior_score`) is picked up automatically as a selectable color feature.
 * `behavior_score` uses a sentinel of -1 for sessions with no known behavior
 * score -- since that would otherwise distort the continuous colorscale, a
 * checkbox (shown only while `behavior_score` is the active color feature)
 * lets those sessions be filtered out of the plot.
 *
 * el/showMessage/clearMessage/huslPalette/dropNaUnique/firstSeenOrder come
 * from common.js; huslPalette in turn needs vendor/hsluv.js loaded first.
 */

const RESERVED_COLUMNS = new Set(["session", "UMAP1", "UMAP2"]);
const BEHAVIOR_SCORE_COLUMN = "behavior_score";
const UNKNOWN_BEHAVIOR_SCORE = -1;

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
      "No data/session_map.json found. Set session_map_csv in export_config.yaml and re-run export_data.py to generate it.",
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
  if (rows.length === 0) {
    showMessage("data/session_map.json is empty.", "warning");
    return;
  }

  STATE.rows = rows;
  el("sidebar-map-options").hidden = false;

  const featureCols = Object.keys(rows[0]).filter((k) => !RESERVED_COLUMNS.has(k));
  const select = el("color-select");
  select.innerHTML = "";
  for (const col of featureCols) {
    const opt = document.createElement("option");
    opt.value = col;
    opt.textContent = col;
    select.appendChild(opt);
  }
  STATE.colorFeature = featureCols[0] || null;
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

function render() {
  const isBehaviorScore = STATE.colorFeature === BEHAVIOR_SCORE_COLUMN;
  el("behavior-score-options").hidden = !isBehaviorScore;

  const rows = (isBehaviorScore && STATE.hideUnknownBehaviorScore)
    ? STATE.rows.filter((r) => r[BEHAVIOR_SCORE_COLUMN] !== UNKNOWN_BEHAVIOR_SCORE)
    : STATE.rows;
  const colorValues = STATE.colorFeature ? rows.map((r) => r[STATE.colorFeature]) : rows.map(() => 0);
  const uniqueVals = dropNaUnique(colorValues);
  const categorical = uniqueVals.length < 20;
  const traces = [];

  const hoverText = (i) => {
    const r = rows[i];
    return r.session_type ? r.session : `${r.session} (no manifold data exported)`;
  };

  if (categorical) {
    const order = firstSeenOrder(colorValues);
    const colors = huslPalette(order.length);
    for (let i = 0; i < order.length; i++) {
      const cat = order[i];
      const idx = [];
      rows.forEach((r, j) => { if (colorValues[j] === cat) idx.push(j); });
      traces.push({
        x: idx.map((j) => rows[j].UMAP1),
        y: idx.map((j) => rows[j].UMAP2),
        mode: "markers",
        type: "scattergl",
        marker: { size: 9, color: colors[i], line: { width: 0 } },
        text: idx.map(hoverText),
        customdata: idx,
        name: `${STATE.colorFeature} = ${cat}`,
        hovertemplate: "%{text}<extra></extra>",
      });
    }
  } else {
    traces.push({
      x: rows.map((r) => r.UMAP1),
      y: rows.map((r) => r.UMAP2),
      mode: "markers",
      type: "scattergl",
      marker: {
        size: 9,
        color: colorValues,
        colorscale: "Viridis",
        colorbar: { title: STATE.colorFeature },
      },
      text: rows.map((_, i) => hoverText(i)),
      customdata: rows.map((_, i) => i),
      hovertemplate: "%{text}<extra></extra>",
    });
  }

  const layout = {
    autosize: true,
    height: 700,
    margin: { l: 50, r: 20, b: 50, t: 20 },
    xaxis: { title: "UMAP1" },
    yaxis: { title: "UMAP2" },
    showlegend: categorical,
    legend: { title: { text: STATE.colorFeature } },
  };

  Plotly.newPlot("plot", traces, layout, { responsive: true }).then((gd) => {
    gd.on("plotly_click", (data) => {
      const pt = data.points[0];
      const row = rows[pt.customdata];
      clearMessage();
      if (row.session_type) {
        window.location.href = `index.html?session_type=${encodeURIComponent(row.session_type)}&session=${encodeURIComponent(row.session)}`;
      } else {
        showMessage(
          `No exported manifold data for "${row.session}" -- it wasn't part of the last export_data.py run.`,
          "warning"
        );
      }
    });
  });

  const nClickable = rows.filter((r) => r.session_type).length;
  el("caption").textContent = `${rows.length} session(s), ${nClickable} with manifold data available -- click a point to open its manifold view.`;
}

init();
