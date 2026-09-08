/*
 * Small helpers shared between index.html/app.js (the per-session manifold
 * viewer) and sessions_map.html/map.js (the 2D session map). Load this
 * before either page's own script.
 */

// px.colors.qualitative.Plotly, same order as the Python palette.
const PALETTE = [
  "#636EFA", "#EF553B", "#00CC96", "#AB63FA", "#FFA15A",
  "#19D3F3", "#FF6692", "#B6E880", "#FF97FF", "#FECB52",
];

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
