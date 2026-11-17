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
 *   - the session dropdown is keyed by session name alone (within the
 *     animal picked in the Animal dropdown above it, which lists the animals
 *     left after the metadata filters; a deep link selects its session's
 *     animal); if two
 *     session_types share a session name, the later one (in metadata row
 *     order) wins.
 *
 * Sidebar choices (filters, animal, session, view mode, color choices,
 * maze_group checkboxes) are saved to localStorage (saveViewerState, keys in
 * common.js) on every render and restored on load, so they survive switching
 * to sessions_map.html and back. Filters are stored as the UNchecked values
 * (computeFilterChain), so new / reappearing options start checked. A deep
 * link from the map (?session=...) overrides the saved session and re-checks
 * its session_type / manifold_cluster if the restored filters would hide it.
 *
 * Missing filter values: a session with no value in a filter column (e.g. no
 * manifold_cluster -- sessions whose lap averaging found 0 groups are never
 * clustered) gets a "none" option (MISSING_FILTER_VALUE, stored as null) in
 * that filter instead of being silently dropped by it.
 *
 * Sessions without an averaged manifold (n_groups_after_averaging == 0, or
 * an empty _avg.csv -> session.avg null): the "Averaged manifold" and
 * "Geodesic matrix" radio buttons are disabled and the full manifold is
 * shown; the chosen view mode itself is kept, so the next session that has
 * an averaged manifold opens in it again.
 *
 * Averaged manifold, "Color by > maze group": colors come from common.js's
 * groupColor (one color family per maze group, a shade per sub-group
 * N2N_0, N2N_1, ...), not from the order the groups appear in.
 */

const MAZE_GROUPS = ["N2N", "F2F", "N2F", "F2N"];
const COLOR_FEATURES = ["position", "speed", "time", "reward"];
// Reward zone of each maze, in cm (same as the pipeline's NEAR/FAR_REWARD_ZONE).
const REWARD_ZONES = { N: [78, 96], F: [120, 138] };
const FILTER_COLUMNS = [
  { col: "session_type", label: "session_type" },
  { col: "manifold_cluster", label: "manifold_cluster" },
];

const STATE = {
  config: null,
  metadata: [],
  filterExcluded: {}, // col -> Set of UNchecked values (missing = nothing unchecked); see computeFilterChain
  selectedAnimal: null, // animalOf(row) -- the session dropdown lists only this animal's sessions
  selectedSession: null, // session name (string)
  sessionCache: new Map(), // "type/name" -> parsed session json
  viewMode: "full",
  colorChoice: null,
  avgColorChoice: "group", // "group" | "position"
  selectedMazeGroups: null, // Set, per-session (reset when session changes)
};

// el/showMessage/clearMessage/clearPlot/dropNaUnique/sortMixed/
// firstSeenOrder/PALETTE come from common.js.

// ---- cascading metadata filters (session_type -> manifold_cluster), mirroring the original app's sequential filter
// narrowing -----------------------------------------------------------

// Option standing for "no value" in a metadata filter (see module docstring).
const MISSING_FILTER_VALUE = null;
const isMissingValue = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
const filterValue = (v) => (isMissingValue(v) ? MISSING_FILTER_VALUE : v);

function computeFilterChain() {
  let df = STATE.metadata;
  const chain = []; // {col, label, options, selected} per rendered filter
  for (const { col, label } of FILTER_COLUMNS) {
    if (df.length === 0 || !(col in df[0])) continue; // column absent -> no-op, no widget
    const options = sortMixed(dropNaUnique(df.map((r) => r[col])));
    if (df.some((r) => isMissingValue(r[col]))) options.push(MISSING_FILTER_VALUE);
    // The state is the set of UNchecked values, not the checked ones: an option
    // that is new (e.g. "none"), or that reappears after an upstream filter
    // hid it for a while, starts checked instead of silently hiding its
    // sessions. Excluded values that are not options right now are kept, so
    // they stay unchecked when they come back.
    const excluded = STATE.filterExcluded[col] || (STATE.filterExcluded[col] = new Set());
    const selected = new Set(options.filter((v) => !excluded.has(v)));
    chain.push({ col, label, options, selected });
    // "if not selected: return df" -- an emptied multiselect is a no-op, not a "show nothing" filter
    if (selected.size > 0) {
      df = df.filter((r) => selected.has(filterValue(r[col])));
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
        const excluded = STATE.filterExcluded[col];
        if (cb.checked) excluded.delete(opt);
        else excluded.add(opt);
        renderSessionSection();
      });
      optLabel.appendChild(cb);
      optLabel.appendChild(document.createTextNode(opt === MISSING_FILTER_VALUE ? "none" : String(opt)));
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
    el("animal-select-label").textContent = "";
    el("animal-select").innerHTML = "";
    el("session-select-label").textContent = "";
    el("session-select").innerHTML = "";
    el("sidebar-view-section").hidden = true;
    el("sidebar-full-options").hidden = true;
    el("sidebar-avg-options").hidden = true;
    el("session-subheader").textContent = "";
    clearPlot();
    showMessage("No sessions match the current filters.", "warning");
    saveViewerState();
    return;
  }

  // animal first: keep the chosen animal if it survived the filters, else the
  // animal of the current (e.g. deep-linked) session, else the first one
  const animalCounts = new Map();
  for (const row of filteredRows) animalCounts.set(animalOf(row), (animalCounts.get(animalOf(row)) || 0) + 1);
  const animals = sortMixed([...animalCounts.keys()]);
  if (!STATE.selectedAnimal || !animalCounts.has(STATE.selectedAnimal)) {
    const current = filteredRows.find((r) => String(r.session) === STATE.selectedSession);
    STATE.selectedAnimal = current ? animalOf(current) : animals[0];
  }
  el("animal-select-label").textContent = `Animal (${animals.length})`;
  fillSelect(el("animal-select"), animals, {
    selected: STATE.selectedAnimal,
    labels: (a) => `${a} (${animalCounts.get(a)})`,
  });

  // last-wins on duplicate session names, in row order
  const labelToRow = new Map();
  for (const row of filteredRows) {
    if (animalOf(row) === STATE.selectedAnimal) labelToRow.set(String(row.session), row);
  }
  const sessionLabels = sortMixed([...labelToRow.keys()]);

  if (!STATE.selectedSession || !labelToRow.has(STATE.selectedSession)) {
    STATE.selectedSession = sessionLabels[0];
  }

  el("session-select-label").textContent = `Session (${sessionLabels.length})`;
  fillSelect(el("session-select"), sessionLabels, { selected: STATE.selectedSession });

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

// ---- remembered settings (see the module docstring) ----------------------

function saveViewerState() {
  const filters = {};
  for (const [col, ex] of Object.entries(STATE.filterExcluded)) filters[col] = [...ex];
  saveSettings(SETTINGS_KEYS.viewer, {
    filtersExcluded: filters, // (older saves had "filters" = checked values; ignored)
    selectedAnimal: STATE.selectedAnimal,
    selectedSession: STATE.selectedSession,
    viewMode: STATE.viewMode,
    colorChoice: STATE.colorChoice,
    avgColorChoice: STATE.avgColorChoice,
    mazeGroups: STATE.selectedMazeGroups ? [...STATE.selectedMazeGroups] : null,
    mazeGroupsForSession: STATE._mazeGroupsForSession ?? null,
  });
}

function restoreViewerState() {
  const s = loadSettings(SETTINGS_KEYS.viewer);
  const cols = new Set(FILTER_COLUMNS.map((f) => f.col));
  for (const [col, vals] of Object.entries(s.filtersExcluded || {})) {
    if (cols.has(col) && Array.isArray(vals)) STATE.filterExcluded[col] = new Set(vals);
  }
  if (s.selectedAnimal) STATE.selectedAnimal = s.selectedAnimal;
  if (s.selectedSession) STATE.selectedSession = s.selectedSession;
  if (["full", "avg", "geo"].includes(s.viewMode)) STATE.viewMode = s.viewMode;
  if (COLOR_FEATURES.includes(s.colorChoice)) STATE.colorChoice = s.colorChoice;
  if (["group", "position"].includes(s.avgColorChoice)) STATE.avgColorChoice = s.avgColorChoice;
  if (Array.isArray(s.mazeGroups) && s.mazeGroupsForSession) {
    STATE.selectedMazeGroups = new Set(s.mazeGroups);
    STATE._mazeGroupsForSession = s.mazeGroupsForSession;
  }
  const radio = document.querySelector(`input[name="view-mode"][value="${STATE.viewMode}"]`);
  if (radio) radio.checked = true;
}

async function loadAndRenderSession(row) {
  saveViewerState();
  clearMessage();
  clearPlot();
  el("sidebar-view-section").hidden = false;

  let session;
  try {
    session = await fetchSessionData(row.session_type, row.session);
  } catch (err) {
    el("sidebar-full-options").hidden = true;
    el("sidebar-avg-options").hidden = true;
    showMessage(`Failed to load data/${row.session_type}/${row.session}.json (${err.message}).`, "error");
    return;
  }

  // no averaged manifold -> avg / geo views unavailable, fall back to full (STATE.viewMode is kept)
  const hasAvg = Boolean(session.avg) && Number(row.n_groups_after_averaging) !== 0;
  for (const mode of ["avg", "geo"]) {
    const radio = document.querySelector(`input[name="view-mode"][value="${mode}"]`);
    radio.disabled = !hasAvg;
    radio.parentElement.classList.toggle("disabled", !hasAvg);
    radio.parentElement.title = hasAvg ? "" : "No averaged manifold for this session (0 groups after averaging)";
  }
  const viewMode = hasAvg ? STATE.viewMode : "full";
  document.querySelector(`input[name="view-mode"][value="${viewMode}"]`).checked = true;

  el("sidebar-avg-options").hidden = viewMode !== "avg";
  if (viewMode === "avg") {
    el("sidebar-full-options").hidden = true;
    renderAveraged(session);
  } else if (viewMode === "geo") {
    el("sidebar-full-options").hidden = true;
    renderGeodesic(session);
  } else {
    renderFull(session);
    if (!hasAvg && STATE.viewMode !== "full") {
      showMessage("This session has no averaged manifold (0 groups after averaging) -- showing the full manifold.", "info");
    }
  }
}

function renderAveraged(session) {
  if (!session.avg) {
    showMessage("Missing averaged manifold CSV for this session (or it has no 'Group' column).", "error");
    return;
  }
  const { UMAP_1, UMAP_2, UMAP_3, Group, position_bin } = session.avg;

  const avgSelect = el("avg-color-select");
  const posOption = avgSelect.querySelector('option[value="position"]');
  posOption.disabled = !position_bin;
  if (!position_bin) STATE.avgColorChoice = "group";
  avgSelect.value = STATE.avgColorChoice;
  avgSelect.onchange = () => {
    STATE.avgColorChoice = avgSelect.value;
    refreshCurrentSession();
  };

  const pointSize = STATE.config.plot.avg_plot_point_size;
  if (STATE.avgColorChoice === "position") {
    plotManifold(UMAP_1, UMAP_2, UMAP_3, position_bin, "Position (cm)", pointSize, { continuous: true });
  } else {
    plotManifold(UMAP_1, UMAP_2, UMAP_3, Group, "Maze group", pointSize, { colorFor: groupColor, sortLegend: true });
  }

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
    colorscale: "inferno", //[[0, "white" ], [0.5, "white"], [1, "#d94801"]],
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

  if (STATE.colorChoice === "reward") {
    renderRewardZones(session, idx, u1, u2, u3, selectedGroups);
    return;
  }

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

// "reward zone & licks" coloring: every point grey, except those inside the
// reward zone of their lap's current maze (last letter of maze_group:
// N2F -> Far) and the bins with licks (red) / reward deliveries (from the
// "licks"/"reward" arrays export_data.py takes from the NWB -- log Lick and
// ActionType == "TrialReward"; absent if add_reward.py wasn't run).
function renderRewardZones(session, idx, u1, u2, u3, selectedGroups) {
  const manifold = session.manifold;
  const maze = lapMazeAt(manifold.t, session.laps);
  const pointSize = STATE.config.plot.point_size ?? 2;

  const groups = { other: [], zone: [], lick: [], reward: [] };
  idx.forEach((i, j) => {
    const zone = REWARD_ZONES[maze[i]];
    const pos = manifold.position[i];
    groups[zone && pos >= zone[0] && pos <= zone[1] ? "zone" : "other"].push(j);
    if (manifold.licks && manifold.licks[i] > 0) groups.lick.push(j);
    if (manifold.reward && manifold.reward[i] > 0) groups.reward.push(j);
  });

  const trace = (pts, name, marker, hover) => ({
    x: pts.map((j) => u1[j]),
    y: pts.map((j) => u2[j]),
    z: pts.map((j) => u3[j]),
    mode: "markers",
    type: "scatter3d",
    name,
    marker: { line: { width: 0 }, ...marker },
    customdata: pts.map((j) => [manifold.position[idx[j]], hover ? hover[idx[j]] : 0]),
    hovertemplate: `${name}<br>Position : %{customdata[0]:.1f}` +
      (hover ? ` -- count %{customdata[1]}` : "") + "<extra></extra>",
  });
  const traces = [
    trace(groups.other, "outside reward zone", { size: pointSize, color: "#c8c8c8", opacity: 0.4 }),
    trace(groups.zone, "reward zone", { size: pointSize + 1, color: "#2a7fff", opacity: 0.8 }),
  ];
  if (manifold.licks) {
    traces.push(trace(groups.lick, "lick", { size: pointSize + 3, color: "#d62728" }, manifold.licks));
  }
  if (manifold.reward) {
    traces.push(trace(groups.reward, "reward delivery",
      { size: pointSize + 5, color: "#ffb000", symbol: "diamond", line: { width: 1, color: "#000000" } },
      manifold.reward));
  }

  const layout = {
    autosize: true,
    height: STATE.config.plot.height ?? 600,
    margin: { l: 0, r: 0, b: 0, t: 10 },
    showlegend: true,
    legend: { itemsizing: "constant" },
  };
  Plotly.newPlot("plot", traces, layout, { responsive: true });

  let caption = `${idx.length} points shown -- maze_group in {${selectedGroups.join(", ")}} -- ` +
    `${groups.zone.length} in reward zone (Near ${REWARD_ZONES.N.join("-")} cm, Far ${REWARD_ZONES.F.join("-")} cm)`;
  caption += manifold.licks
    ? `, ${groups.lick.length} bins with licks, ${groups.reward.length} with reward delivery`
    : " -- no lick/reward data for this session (re-run export_data.py after add_reward.py)";
  el("caption").textContent = caption;
}

// Current maze ("N"/"F", the last letter of the lap's maze_group) for every
// timestamp in sorted `t`, null outside laps -- same single sweep as
// restrictToMazeGroups.
function lapMazeAt(t, laps) {
  const out = new Array(t.length).fill(null);
  let li = 0;
  for (let i = 0; i < t.length; i++) {
    while (li < laps.start.length && t[i] > laps.end[li]) li++;
    if (li < laps.start.length && t[i] >= laps.start[li]) {
      const g = laps.maze_group[li];
      out[i] = g ? g[g.length - 1] : null;
    }
  }
  return out;
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

// opts.continuous forces the colormap branch even for < 20 distinct values
// (e.g. the averaged manifold's position_bin). opts.colorFor(category) gives a
// fixed color for a category (null -> fall back to PALETTE by first-seen
// index); opts.sortLegend orders the categories naturally (N2N_0, N2N_1, ...).
function plotManifold(u1, u2, u3, colorValues, colorLabel, pointSize, opts = {}) {
  const uniqueVals = dropNaUnique(colorValues);
  const categorical = !opts.continuous && uniqueVals.length < 20;
  const traces = [];
  if (categorical) {
    // categorical branch: one trace per distinct value, in first-seen order
    let order = firstSeenOrder(colorValues);
    if (opts.sortLegend) {
      order = [...order].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    }
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
        marker: { size: pointSize ?? 5, color: (opts.colorFor && opts.colorFor(cat)) || PALETTE[i % PALETTE.length], line: { width: 0 } },
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
    showlegend: categorical,
    legend: { title: { text: colorLabel } },
  };
  Plotly.newPlot("plot", traces, layout, { responsive: true });
}

// ---- boot -------------------------------------------------------------

async function init() {
  el("reload-btn").addEventListener("click", () => {
    clearSettings(); // also forget the remembered sidebar choices
    location.reload();
  });
  restoreViewerState();
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

  el("animal-select").addEventListener("change", (e) => {
    STATE.selectedAnimal = e.target.value;
    renderSessionSection(); // switches to the animal's first session
  });

  el("session-select").addEventListener("change", (e) => {
    STATE.selectedSession = e.target.value;
    const { filteredRows } = computeFilterChain();
    const row = filteredRows.find((r) => String(r.session) === STATE.selectedSession);
    el("session-subheader").textContent = row ? `${row.session_type} / ${row.session}` : "";
    if (row) loadAndRenderSession(row);
  });

  // deep link from sessions_map.html (index.html?session=<name>&session_type=<type>)
  // -- overrides the remembered session; filters restored from localStorage
  // that would hide it get its values added back, so the linked session is
  // guaranteed to show up as long as it's in session_metadata.json.
  const params = new URLSearchParams(window.location.search);
  const linkedSession = params.get("session");
  if (linkedSession) {
    const linkedType = params.get("session_type");
    const match = STATE.metadata.find(
      (r) => String(r.session) === linkedSession && (!linkedType || String(r.session_type) === linkedType)
    );
    if (match) {
      STATE.selectedSession = linkedSession;
      STATE.selectedAnimal = animalOf(match);
      for (const { col } of FILTER_COLUMNS) {
        STATE.filterExcluded[col]?.delete(filterValue(match[col]));
      }
    }
  }

  renderSessionSection();
}

init();
