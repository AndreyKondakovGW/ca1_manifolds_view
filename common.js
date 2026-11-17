/*
 * Small helpers shared between index.html/app.js (the per-session manifold
 * viewer) and sessions_map.html/map.js (the 2D session map). Load this
 * before either page's own script.
 *
 * animalOf/fillSelect back the animal -> session pickers of both pages: an
 * animal is chosen first and the session dropdown then lists only its
 * sessions.
 *
 * loadSettings/saveSettings keep each page's sidebar choices in localStorage
 * so they survive switching between the two pages; the "Clear cache &
 * reload" button of both pages also clears them (clearSettings).
 * groupColor gives the averaged manifold's maze-group colors.
 */

// px.colors.qualitative.Plotly, same order as the Python palette.
const PALETTE = [
  "#08519c", "#fdae6b", "#9ecae1", "#d94801", "#FFA15A",
  "#19D3F3", "#FF6692", "#B6E880", "#FF97FF", "#FECB52",
];

// Averaged-manifold group colors: one fixed color family per maze group (the
// hue is the current maze -- blues end in F, oranges end in N; darker = same
// maze as the previous lap, lighter = maze just switched -- the same 4 colors
// PALETTE[0..3] used to give these groups in their sorted order). A switcher
// session can average a group into several sub-groups (N2N_0, N2N_1, ...);
// sub-group k gets shade k of its family, so sub-groups of one maze group
// read as related but stay distinguishable. Shades cycle after the 4th.
const GROUP_COLOR_FAMILIES = {
  F2F: ["#08519c", "#3f2b96", "#1d91c0", "#08306b"],
  N2F: ["#9ecae1", "#7fcdbb", "#bcbddc", "#5e9fd1"],
  N2N: ["#d94801", "#8c2d04", "#e31a1c", "#b15928"],
  F2N: ["#fdae6b", "#fec44f", "#f4a582", "#e6853f"],
};

// Color of an averaged-manifold group label ("N2N", "N2N_1", ...), or null
// for a label that isn't <maze group>[_<k>].
function groupColor(label) {
  const m = /^([NF]2[NF])(?:_(\d+))?$/.exec(String(label));
  if (!m || !GROUP_COLOR_FAMILIES[m[1]]) return null;
  const shades = GROUP_COLOR_FAMILIES[m[1]];
  return shades[Number(m[2] || 0) % shades.length];
}

// Per-page settings remembered across page switches (index.html <->
// sessions_map.html) and reloads, in localStorage. Every access is wrapped:
// storage can be unavailable (private window, blocked site data), in which
// case the pages simply start from their defaults.
const SETTINGS_KEYS = { viewer: "ca1view.viewer", map: "ca1view.map" };

function loadSettings(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch (_) {
    return {};
  }
}

function saveSettings(key, obj) {
  try {
    localStorage.setItem(key, JSON.stringify(obj));
  } catch (_) {
    // storage unavailable -- settings just aren't remembered
  }
}

function clearSettings() {
  try {
    Object.values(SETTINGS_KEYS).forEach((k) => localStorage.removeItem(k));
  } catch (_) {
    // nothing to clear
  }
}

const el = (id) => document.getElementById(id);

function showMessage(text, kind) {
  const box = el("message");
  box.textContent = text;
  box.className = `message ${kind}`;
  box.hidden = false;
}

function clearMessage() {
  const box = el("message");
  box.hidden = true;
  box.textContent = "";
}

function clearPlot() {
  Plotly.purge("plot");
  el("caption").textContent = "";
}

function dropNaUnique(values) {
  const seen = new Set();
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number" && Number.isNaN(v)) continue;
    seen.add(v);
  }
  return [...seen];
}

function sortMixed(values) {
  const arr = [...values];
  const allNumeric = arr.every((v) => typeof v === "number");
  if (allNumeric) return arr.sort((a, b) => a - b);
  return arr.sort((a, b) => String(a).localeCompare(String(b)));
}

// First-seen order of distinct values -- used to assign stable palette
// indices/trace order for a categorical color feature (matches pandas'
// `.unique()` order, which the original app's coloring logic relies on).
function firstSeenOrder(values) {
  const seen = new Set();
  const order = [];
  for (const v of values) {
    if (!seen.has(v)) { seen.add(v); order.push(v); }
  }
  return order;
}

// N evenly-spaced-hue colors via HSLuv (vendor/hsluv.js -- loaded before this
// on pages that need it, e.g. sessions_map.html) instead of cycling a fixed
// palette, so a categorical feature with many distinct values (a session map
// can easily have more clusters than PALETTE's 10 colors) never repeats a
// color regardless of how many are needed. Saturation/lightness match
// seaborn's `sns.color_palette("husl", n)` defaults.
function huslPalette(n) {
  const colors = [];
  for (let i = 0; i < n; i++) {
    const hue = (360 * i) / n;
    colors.push(hsluv.Hsluv.hsluvToHex([hue, 89, 65]));
  }
  return colors;
}

// Animal a session belongs to: the metadata's `animal_id` column, or (for
// older exports without it) the session name's prefix before the first "_"
// (e.g. "EH029_251106" -> "EH029") -- used by both pages' animal -> session
// pickers.
function animalOf(row) {
  const id = row.animal_id;
  if (id !== null && id !== undefined && id !== "") return String(id);
  return String(row.session).split("_")[0];
}

// Fill a <select> with `values` (strings), optionally preceded by a
// placeholder option with value "", selecting `selected` if present.
function fillSelect(select, values, { selected = null, placeholder = null, labels = null } = {}) {
  select.innerHTML = "";
  if (placeholder !== null) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = labels ? labels(v) : v;
    if (v === selected) opt.selected = true;
    select.appendChild(opt);
  }
  if (selected === null && placeholder !== null) select.value = "";
}
