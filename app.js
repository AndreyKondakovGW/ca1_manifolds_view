/*
 * Reads the JSON files produced by export_data.py
 * (data/session_metadata.json + data/<session_type>/<session>.json) and
 * renders them with Plotly.js -- a static-site port of an internal
 * Streamlit viewer (not included in this repo), reimplementing that app's
 * filtering/view logic and its coloring (originally Python's
 * manifold_plot3d) in plain JS.
 *
 * Two quirks kept intentionally (matched the original app's behavior, not
 * bugs introduced here):
 *   - an emptied filter selection means "no filter" (show everything), not
 *     "show nothing".
 *   - the session dropdown is keyed by session name alone; if two
 *     session_types share a session name, the later one (in metadata row
 *     order) wins.
 */

const MAZE_GROUPS = ["N2N", "F2F", "N2F", "F2N"];
const COLOR_FEATURES = ["position", "speed", "time"];
const FILTER_COLUMNS = [
  { col: "session_type", label: "session_type" },
  { col: "n_groups_after_averaging", label: "n_groups_after_averaging" },
  { col: "manifold_cluster", label: "manifold_cluster" },
];

const STATE = {
  config: null,
  metadata: [],
  filterSelections: {}, // col -> Set of selected values (undefined = not yet initialized)
  selectedSession: null, // session name (string)
  sessionCache: new Map(), // "type/name" -> parsed session json
  viewMode: "full",
  colorChoice: null,
  selectedMazeGroups: null, // Set, per-session (reset when session changes)
};

// el/showMessage/clearMessage/clearPlot/dropNaUnique/sortMixed/
// firstSeenOrder/PALETTE come from common.js.

// ---- cascading metadata filters (session_type -> n_groups_after_averaging
// -> manifold_cluster), mirroring the original app's sequential filter
// narrowing -----------------------------------------------------------

function computeFilterChain() {
  let df = STATE.metadata;
  const chain = []; // {col, label, options, selected} per rendered filter
  for (const { col, label } of FILTER_COLUMNS) {
    if (df.length === 0 || !(col in df[0])) continue; // column absent -> no-op, no widget
    const options = sortMixed(dropNaUnique(df.map((r) => r[col])));
    if (STATE.filterSelections[col] === undefined) {
      STATE.filterSelections[col] = new Set(options);
    } else {
      // drop selections that vanished from the option list, keep the rest
      STATE.filterSelections[col] = new Set(
        [...STATE.filterSelections[col]].filter((v) => options.includes(v))
      );
    }
    const selected = STATE.filterSelections[col];
    chain.push({ col, label, options, selected });
    // "if not selected: return df" -- an emptied multiselect is a no-op, not a "show nothing" filter
    if (selected.size > 0) {
      df = df.filter((r) => selected.has(r[col]));
    }
  }
  return { filteredRows: df, chain };
}

function renderFilters(chain) {
  const container = el("filters");
  container.innerHTML = "";
  for (const { col, label, options, selected } of chain) {
    const wrap = document.createElement("div");
    const lbl = document.createElement("div");
    lbl.className = "field-label";
    lbl.textContent = label;
    wrap.appendChild(lbl);

    const box = document.createElement("div");
    box.className = "multiselect";
    for (const opt of options) {
      const optLabel = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(opt);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(opt);
        else selected.delete(opt);
        STATE.filterSelections[col] = selected;
        renderSessionSection();
      });
      optLabel.appendChild(cb);
      optLabel.appendChild(document.createTextNode(String(opt)));
      box.appendChild(optLabel);
    }
    wrap.appendChild(box);
    container.appendChild(wrap);
  }
}

// ---- session picking -------------------------------------------------------

function renderSessionSection() {
  const { filteredRows, chain } = computeFilterChain();
  renderFilters(chain);

  el("sidebar-session-section").hidden = false;

  if (filteredRows.length === 0) {
    el("session-select-label").textContent = "";
    el("session-select").innerHTML = "";
    el("sidebar-view-section").hidden = true;
    el("sidebar-full-options").hidden = true;
    el("session-subheader").textContent = "";
    clearPlot();
    showMessage("No sessions match the current filters.", "warning");
    return;
  }

  // last-wins on duplicate session names, in row order
  const labelToRow = new Map();
  for (const row of filteredRows) labelToRow.set(String(row.session), row);
  const sessionLabels = sortMixed([...labelToRow.keys()]);

  if (!STATE.selectedSession || !labelToRow.has(STATE.selectedSession)) {
    STATE.selectedSession = sessionLabels[0];
  }

  el("session-select-label").textContent = `Session (${sessionLabels.length})`;
  const select = el("session-select");
  select.innerHTML = "";
  for (const label of sessionLabels) {
    const opt = document.createElement("option");
    opt.value = label;
    opt.textContent = label;
    if (label === STATE.selectedSession) opt.selected = true;
    select.appendChild(opt);
  }

  const row = labelToRow.get(STATE.selectedSession);
  el("session-subheader").textContent = `${row.session_type} / ${row.session}`;
  loadAndRenderSession(row);
}

// ---- per-session data + rendering -----------------------------------------

async function fetchSessionData(sessionType, sessionName) {
  const key = `${sessionType}/${sessionName}`;
  if (STATE.sessionCache.has(key)) return STATE.sessionCache.get(key);
  const resp = await fetch(`data/${key}.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  STATE.sessionCache.set(key, json);
  return json;
}

async function loadAndRenderSession(row) {
  clearMessage();
  clearPlot();
  el("sidebar-view-section").hidden = false;

  let session;
  try {
    session = await fetchSessionData(row.session_type, row.session);
  } catch (err) {
    el("sidebar-full-options").hidden = true;
    showMessage(`Failed to load data/${row.session_type}/${row.session}.json (${err.message}).`, "error");
    return;
  }

  if (STATE.viewMode === "avg") {
    el("sidebar-full-options").hidden = true;
    renderAveraged(session);
  } else if (STATE.viewMode === "geo") {
    el("sidebar-full-options").hidden = true;
    renderGeodesic(session);
  } else {
    renderFull(session);
  }
}

function renderAveraged(session) {
  if (!session.avg) {
    showMessage("Missing averaged manifold CSV for this session (or it has no 'Group' column).", "error");
    return;
  }
  const { UMAP_1, UMAP_2, UMAP_3, Group } = session.avg;
  const X1 = UMAP_1, X2 = UMAP_2, X3 = UMAP_3;
  plotManifold(X1, X2, X3, Group, "Maze group", STATE.config.plot.avg_plot_point_size);

  const groups = sortMixed(dropNaUnique(Group));
  el("caption").textContent = `${Group.length} averaged points, groups: ${groups.join(", ")}`;
}

// Ported from the original app's geodesic distance matrix plot, run on the
// same averaged-manifold points as the "Averaged manifold" view (the matrix
// itself is precomputed by export_data.py, since that's too slow to run in
// a browser). Unlike the Python version (which hardcodes 4 equal-size
// group blocks: F2F/F2N/N2F/N2N), block boundaries here are derived from
// the actual contiguous runs of session.avg.Group, so it also works for a
// "switcher" session with more than 4 averaged groups.
function renderGeodesic(session) {
  if (!session.geodesic_matrix || !session.avg) {
    showMessage(
      "Missing geodesic distance matrix for this session (needs an averaged manifold to compute it from).",
      "error"
    );
    return;
  }
  const matrix = session.geodesic_matrix;
  const groupCol = session.avg.Group;
  const posBin = session.avg.position_bin || null;
  const n = matrix.length;

  // contiguous runs of Group, in appearance order -- e.g. ["F2F_0","F2N_0","N2F_0","N2N_0"]
  const blocks = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || groupCol[i] !== groupCol[i - 1]) blocks.push({ name: groupCol[i], start: i, end: i });
    else blocks[blocks.length - 1].end = i;
  }
  const tickvals = blocks.map((b) => (b.start + b.end) / 2);
  const ticktext = blocks.map((b) => b.name);
  const boundaries = blocks.slice(0, -1).map((b) => b.end + 0.5);

  const idx = matrix.map((_, i) => i);
  const customdata = posBin
    ? matrix.map((row, i) => idx.map((j) => [posBin[j], posBin[i]]))
    : undefined;

  const shapes = [];
  for (const b of boundaries) {
    shapes.push({ type: "line", xref: "x", yref: "paper", x0: b, x1: b, y0: 0, y1: 1, line: { color: "white", width: 2 } });
    shapes.push({ type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: b, y1: b, line: { color: "white", width: 2 } });
  }

  const trace = {
    z: matrix,
    x: idx,
    y: idx,
    type: "heatmap",
    colorscale: [[0, "blue"], [0.5, "white"], [1, "red"]],
    colorbar: { title: "distance" },
    ...(customdata ? {
      customdata,
      hovertemplate: "Position : %{customdata[0]:.1f}, %{customdata[1]:.1f}<extra></extra>",
    } : {}),
  };

  const layout = {
    autosize: true,
    height: STATE.config.plot.height ?? 700,
    margin: { l: 60, r: 20, b: 60, t: 20 },
    xaxis: { tickmode: "array", tickvals, ticktext },
    yaxis: { tickmode: "array", tickvals, ticktext },
    shapes,
  };
  Plotly.newPlot("plot", [trace], layout, { responsive: true });
  el("caption").textContent = `${n} x ${n} geodesic distance matrix -- groups: ${ticktext.join(", ")}`;
}

function renderFull(session) {
  const manifold = session.manifold;
  if (!manifold) {
    el("sidebar-full-options").hidden = true;
    showMessage(
      "This session's NWB file has no 'manifold' acquisition yet (stage 2 of the pipeline hasn't been run for it).",
      "error"
    );
    return;
  }
  el("sidebar-full-options").hidden = false;

  const lapsMazeGroups = session.laps.maze_group;
  const availableGroups = MAZE_GROUPS.filter((g) => lapsMazeGroups.includes(g));

  // reset the maze_group selection whenever we land on a different session
  if (!STATE.selectedMazeGroups || STATE._mazeGroupsForSession !== STATE.selectedSession) {
    STATE.selectedMazeGroups = new Set(availableGroups);
    STATE._mazeGroupsForSession = STATE.selectedSession;
  }

  if (STATE.colorChoice === null) {
    const dflt = STATE.config.default_color_feature;
    STATE.colorChoice = COLOR_FEATURES.includes(dflt) ? dflt : COLOR_FEATURES[0];
  }

  renderFullOptions(availableGroups);

  const selectedGroups = [...STATE.selectedMazeGroups];
  if (selectedGroups.length === 0) {
    showMessage("Select at least one maze_group.", "warning");
    return;
  }

  const idx = restrictToMazeGroups(manifold.t, session.laps, selectedGroups);
  if (idx.length === 0) {
    showMessage("No manifold points fall inside the selected maze_group(s).", "warning");
    return;
  }

  const u1 = idx.map((i) => manifold.UMAP1[i]);
  const u2 = idx.map((i) => manifold.UMAP2[i]);
  const u3 = idx.map((i) => manifold.UMAP3[i]);
  let color, colorLabel;
  if (STATE.colorChoice === "position") {
    color = idx.map((i) => manifold.position[i]);
    colorLabel = "Position (cm)";
  } else if (STATE.colorChoice === "speed") {
    color = idx.map((i) => manifold.speed[i]);
    colorLabel = "Speed (cm/s)";
  } else {
    color = idx.map((i) => manifold.t[i]);
    colorLabel = "Time (s)";
  }

  plotManifold(u1, u2, u3, color, colorLabel, STATE.config.plot.point_size);
  el("caption").textContent = `${u1.length} points shown -- maze_group in {${selectedGroups.join(", ")}}`;
}

function renderFullOptions(availableGroups) {
  const colorSelect = el("color-select");
  colorSelect.value = STATE.colorChoice;
  colorSelect.onchange = () => {
    STATE.colorChoice = colorSelect.value;
    refreshCurrentSession();
  };

  const box = el("maze-group-checks");
  box.innerHTML = "";
  for (const g of availableGroups) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = STATE.selectedMazeGroups.has(g);
    cb.addEventListener("change", () => {
      if (cb.checked) STATE.selectedMazeGroups.add(g);
      else STATE.selectedMazeGroups.delete(g);
      refreshCurrentSession();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(g));
    box.appendChild(label);
  }
}

function refreshCurrentSession() {
  const { filteredRows } = computeFilterChain();
  const row = filteredRows.find((r) => String(r.session) === STATE.selectedSession);
  if (row) loadAndRenderSession(row);
}

// Restrict a sorted time index to the laps whose maze_group is in
// `selectedGroups`. Both `t` and the laps (by construction, in temporal
// recording order) are sorted ascending, non-overlapping, so a single
// sweep suffices -- equivalent to pynapple's `manifold.restrict(interval)`.
function restrictToMazeGroups(t, laps, selectedGroups) {
  const selected = new Set(selectedGroups);
  const starts = [], ends = [];
  for (let i = 0; i < laps.start.length; i++) {
    if (selected.has(laps.maze_group[i])) {
      starts.push(laps.start[i]);
      ends.push(laps.end[i]);
    }
  }
  const idx = [];
  let li = 0;
  for (let i = 0; i < t.length; i++) {
    const tv = t[i];
    while (li < starts.length && tv > ends[li]) li++;
    if (li < starts.length && tv >= starts[li] && tv <= ends[li]) idx.push(i);
  }
  return idx;
}

// ---- plotting, ported from manifold_plot3d's two color branches ----------

function plotManifold(u1, u2, u3, colorValues, colorLabel, pointSize) {
  const uniqueVals = dropNaUnique(colorValues);
  const traces = [];
  if (uniqueVals.length < 20) {
    // categorical branch: one trace per distinct value, in first-seen order
    const order = firstSeenOrder(colorValues);
    for (let i = 0; i < order.length; i++) {
      const cat = order[i];
      const idx = [];
      for (let j = 0; j < colorValues.length; j++) if (colorValues[j] === cat) idx.push(j);
      traces.push({
        x: idx.map((j) => u1[j]),
        y: idx.map((j) => u2[j]),
        z: idx.map((j) => u3[j]),
        mode: "markers",
        type: "scatter3d",
        marker: { size: pointSize ?? 5, color: PALETTE[i % PALETTE.length], line: { width: 0 } },
        name: `${colorLabel} = ${cat}`,
      });
    }
  } else {
    traces.push({
      x: u1, y: u2, z: u3,
      mode: "markers",
      type: "scatter3d",
      marker: {
        size: pointSize ?? 2,
        opacity: 0.8,
        color: colorValues,
        colorscale: "Viridis",
        colorbar: { title: colorLabel },
      },
      customdata: colorValues,
      hovertemplate: `${colorLabel} : %{customdata:.1f}<extra></extra>`,
    });
  }

  const layout = {
    autosize: true,
    height: STATE.config.plot.height ?? 600,
    margin: { l: 0, r: 0, b: 0, t: 10 },
    showlegend: uniqueVals.length < 20,
    legend: { title: { text: colorLabel } },
  };
  Plotly.newPlot("plot", traces, layout, { responsive: true });
}

// ---- boot -------------------------------------------------------------

async function init() {
  el("reload-btn").addEventListener("click", () => location.reload());
  document.querySelectorAll('input[name="view-mode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      if (e.target.checked) {
        STATE.viewMode = e.target.value; // "full" | "avg" | "geo"
        refreshCurrentSession();
      }
    });
  });

  try {
    STATE.config = await (await fetch("config.json")).json();
  } catch (err) {
    showMessage(`Failed to load config.json (${err.message}).`, "error");
    return;
  }

  let exportInfo = null;
  try {
    exportInfo = await (await fetch("data/export_info.json")).json();
  } catch (_) {
    // optional -- export_data.py writes this, but its absence isn't fatal
  }
  el("data-source-caption").textContent = exportInfo
    ? `${exportInfo.data_source} (exported ${exportInfo.exported_at})`
    : "data/";

  let metadataResp;
  try {
    metadataResp = await fetch("data/session_metadata.json");
  } catch (err) {
    showMessage(`Failed to fetch data/session_metadata.json (${err.message}).`, "error");
    return;
  }
  if (!metadataResp.ok) {
    showMessage(
      "No data/session_metadata.json found. Run export_data.py (see export_config.yaml) to generate it.",
      "error"
    );
    return;
  }
  try {
    STATE.metadata = await metadataResp.json();
  } catch (err) {
    // the file exists (fetch above succeeded) but isn't valid JSON -- most
    // likely a NaN/Infinity value that slipped past export_data.py's
    // rounding/null-conversion (those aren't valid JSON, unlike Python's
    // json.dump which allows them by default) -- don't blame a "missing
    // file" for this, it's misleading and sends you looking in the wrong place.
    showMessage(
      `data/session_metadata.json exists but isn't valid JSON (${err.message}). Check export_data.py's console output for errors and re-run it.`,
      "error"
    );
    return;
  }

  el("session-select").addEventListener("change", (e) => {
    STATE.selectedSession = e.target.value;
    STATE.colorChoice = null; // let the new session re-derive its default
    const { filteredRows } = computeFilterChain();
    const row = filteredRows.find((r) => String(r.session) === STATE.selectedSession);
    el("session-subheader").textContent = row ? `${row.session_type} / ${row.session}` : "";
    if (row) loadAndRenderSession(row);
  });

  // deep link from sessions_map.html (index.html?session=<name>&session_type=<type>)
  // -- all filters default to "everything selected" on a fresh load, so the
  // linked session is guaranteed to show up in the dropdown as long as it's
  // actually in session_metadata.json.
  const params = new URLSearchParams(window.location.search);
  const linkedSession = params.get("session");
  if (linkedSession) {
    const linkedType = params.get("session_type");
    const match = STATE.metadata.find(
      (r) => String(r.session) === linkedSession && (!linkedType || String(r.session_type) === linkedType)
    );
    if (match) STATE.selectedSession = linkedSession;
  }

  renderSessionSection();
}

init();
