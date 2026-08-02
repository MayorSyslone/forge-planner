/* ---------------------------------------------------------------------------
   Front end. Recipes arrive from /api/recipes, prices from /api/prices.
   Everything below is display and arithmetic.
--------------------------------------------------------------------------- */
"use strict";

let RECIPES = {}, CATEGORIES = [], BAZAAR = new Set();

const state = {
  build: [],          // [{item, qty}]
  open: new Set(),    // paths of the rows you've opened, e.g. "#0|Mithril Plate"
  prices: {},         // item -> coins each
  times: {},          // item -> corrected forge seconds
  players: [{ name: "You", qf: 20, slots: 5 }],
  cole: false,
  bin: 0,
  tax: 2.5,
};

const $ = id => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

/* ---------------------------------------------------------------- helpers */
const fmt = n => Math.round(n).toLocaleString("en-US");
const money = n => !isFinite(n) || n === 0 ? "0"
  : Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + "b"
  : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + "m"
  : fmt(n);

function dur(s) {
  if (!s) return "—";
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m && !d) parts.push(m + "m");
  return parts.length ? parts.join(" ") : Math.round(s) + "s";
}

/* "1d 6h", "18h", "4h 30m", "30s", or a bare number meaning hours */
function parseDur(str) {
  const s = String(str).trim().toLowerCase();
  if (!s) return null;
  const unit = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0, found = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) { total += parseFloat(m[1]) * unit[m[2]]; found = true; }
  if (!found && /^\d+(\.\d+)?$/.test(s)) { total = parseFloat(s) * 3600; found = true; }
  return found ? Math.round(total) : null;
}

const forgeTime = item =>
  state.times[item] != null ? state.times[item] : (RECIPES[item] ? RECIPES[item].time : 0);

/* -------------------------------------------------------------- the model */
/* One pass down the tree gives cost, forge time and the shopping list.
   A closed row is something you buy, so the walk stops there. */
function walk(item, qty, path, acc) {
  const r = RECIPES[item];
  if (!r || !state.open.has(path)) {
    acc.buy[item] = (acc.buy[item] || 0) + qty;
    return;
  }
  const runs = Math.ceil(qty / (r.out || 1));
  if (!r.craft) { acc.forgeSeconds += runs * forgeTime(item); acc.processes += runs; acc.used.add(item); }
  if (r.coins) acc.coins += runs * r.coins;
  for (const [ing, n] of r.ing) walk(ing, runs * n, path + "|" + ing, acc);
}

const blank = () => ({ buy: {}, forgeSeconds: 0, processes: 0, coins: 0, used: new Set() });

function compute() {
  const acc = blank();
  state.build.forEach((b, i) => walk(b.item, b.qty, "#" + i, acc));
  let materials = 0, missing = 0;
  for (const [item, q] of Object.entries(acc.buy)) {
    const p = state.prices[item];
    if (p == null) missing++;
    materials += (p || 0) * q;
  }
  acc.materials = materials;
  acc.total = materials + acc.coins;
  acc.missing = missing;
  return acc;
}

function subCost(item, qty, path) {
  const a = blank();
  walk(item, qty, path, a);
  let cost = a.coins;
  for (const [it, q] of Object.entries(a.buy)) cost += (state.prices[it] || 0) * q;
  return cost;
}

/* Quick Forge: min(30, 10 + lvl/2 + floor(lvl/20)*10) percent, nothing at 0.
   Cole's Molten Forge adds another 25 on top.
   A slot running at reduction r clears base forge time at 1/(1-r) speed, so a
   crew's capacity is that summed over every slot — which handles a coop where
   everyone has a different perk level. */
const qfCut = lvl => (lvl > 0 ? Math.min(30, 10 + lvl * 0.5 + Math.floor(lvl / 20) * 10) : 0);
const reduction = lvl => Math.min(0.9, qfCut(lvl) / 100 + (state.cole ? 0.25 : 0));
const capacity = () => state.players.reduce((s, p) => s + (p.slots || 0) / (1 - reduction(p.qf || 0)), 0);

/* ------------------------------------------------------------------ search */
let matches = [], sel = 0;

function searchable() {
  return Object.keys(RECIPES).filter(n => !RECIPES[n].craft);
}

function runSearch() {
  const q = $("search").value.trim().toLowerCase();
  const box = $("results");
  if (!q) { box.hidden = true; return; }
  matches = searchable().filter(n => n.toLowerCase().includes(q)).slice(0, 24);
  sel = 0;
  if (!matches.length) {
    box.innerHTML = '<div class="none">Nothing matches. Only items with a forge recipe are listed.</div>';
    box.hidden = false;
    return;
  }
  const groups = {};
  for (const n of matches) (groups[RECIPES[n].cat || "Other"] ||= []).push(n);
  const order = CATEGORIES.filter(c => groups[c]).concat(Object.keys(groups).filter(c => !CATEGORIES.includes(c)));
  let html = "", i = 0;
  for (const cat of order) {
    html += `<div class="grp">${cat}</div>`;
    for (const n of groups[cat]) {
      html += `<div class="opt${i === 0 ? " sel" : ""}" data-i="${i}" role="option">`
        + `<span>${n}</span><span class="t">${forgeTime(n) ? dur(forgeTime(n)) : "instant"}</span></div>`;
      i++;
    }
  }
  /* data-i counts in render order, so re-order matches to match */
  matches = order.flatMap(c => groups[c]);
  box.innerHTML = html;
  box.hidden = false;
}

function highlight() {
  [...document.querySelectorAll("#results .opt")].forEach((o, i) => o.classList.toggle("sel", i === sel));
}

function addItem(name) {
  state.build.push({ item: name, qty: 1 });
  $("search").value = "";
  $("results").hidden = true;
  render();
}

/* ------------------------------------------------------------------ render */
function priceCell(item) {
  const wrap = el("div", "pcell");
  const input = el("input");
  input.type = "number"; input.min = "0"; input.placeholder = "price";
  input.dataset.priceFor = item;
  if (state.prices[item] != null) input.value = state.prices[item];
  else input.classList.add("unset");
  input.addEventListener("input", () => {
    if (input.value === "") delete state.prices[item];
    else state.prices[item] = parseFloat(input.value) || 0;
    document.querySelectorAll("input[data-price-for]").forEach(o => {
      if (o.dataset.priceFor !== item || o === input) return;
      o.value = state.prices[item] ?? "";
      o.classList.toggle("unset", state.prices[item] == null);
    });
    input.classList.toggle("unset", state.prices[item] == null);
    refreshNumbers(); renderShopping(); renderStats(); save();
  });
  wrap.appendChild(input);
  return wrap;
}

function buildRow(item, qty, path, depth, rootIdx) {
  const frag = document.createDocumentFragment();
  const r = RECIPES[item];
  const open = state.open.has(path);

  const row = el("div", "trow " + (open ? "forging" : r ? "buying" : "leaf"));
  if (!depth) row.classList.add("root");
  row.dataset.path = path;
  row.dataset.item = item;

  /* name */
  const name = el("div", "tname");
  if (depth) {
    const rail = el("div", "rail");
    for (let d = 0; d < depth; d++) rail.appendChild(el("i", "lit"));
    name.appendChild(rail);
  }
  const chev = el("button");
  if (r) {
    chev.className = "chev" + (open ? " on" : "");
    chev.textContent = open ? "▼" : "▶";
    chev.setAttribute("aria-expanded", String(open));
    chev.title = open
      ? "Forging this from its parts. Close to buy it instead."
      : r.craft ? "Craft this from raw materials instead of buying it"
                : "Forge this yourself instead of buying it";
    chev.addEventListener("click", () => {
      open ? state.open.delete(path) : state.open.add(path);
      render();
    });
  } else {
    chev.className = "chev none"; chev.textContent = "·"; chev.disabled = true;
  }
  name.append(chev);

  const label = el("span", "tlabel");
  label.textContent = item;
  name.appendChild(label);
  if (!depth && r && r.coins) {
    const tag = el("span", "tag coins");
    tag.textContent = "+" + money(r.coins) + " coins";
    name.appendChild(tag);
  }
  row.appendChild(name);

  /* how many */
  const q = el("div", "num qty");
  if (!depth) {
    const qi = el("input");
    qi.type = "number"; qi.min = "1"; qi.value = qty;
    qi.addEventListener("input", () => {
      state.build[rootIdx].qty = Math.max(1, Math.floor(+qi.value || 1));
      refreshNumbers(); renderShopping(); renderStats(); save();
    });
    q.appendChild(qi);
  } else {
    q.textContent = fmt(qty) + "\u00d7";
  }
  row.appendChild(q);

  /* price each */
  if (open) {
    const fixed = el("div", "pcell");
    fixed.innerHTML = '<div class="fixed">from parts</div>';
    row.appendChild(fixed);
  } else {
    row.appendChild(priceCell(item));
  }

  /* cost */
  const cost = el("div", "num cost");
  cost.textContent = money(subCost(item, qty, path));
  row.appendChild(cost);

  /* each forge */
  const time = el("div", "num time");
  setTimeCell(time, item, qty, path);
  row.appendChild(time);

  /* remove */
  const kill = el("div");
  if (!depth) {
    const b = el("button", "x");
    b.textContent = "\u00d7"; b.title = "Remove this from the build";
    b.addEventListener("click", () => {
      state.build.splice(rootIdx, 1);
      reindex(rootIdx);
      render();
    });
    kill.appendChild(b);
  }
  row.appendChild(kill);

  frag.appendChild(row);

  if (open) {
    const runs = Math.ceil(qty / (r.out || 1));
    for (const [ing, n] of r.ing)
      frag.appendChild(buildRow(ing, runs * n, path + "|" + ing, depth + 1, rootIdx));
  }
  return frag;
}

/* The column shows one forge's duration and how many of them you need —
   the running total lives in the Timing panel. */
function setTimeCell(cell, item, qty, path) {
  const r = RECIPES[item];
  if (!r || r.craft || !state.open.has(path)) { cell.textContent = ""; cell.title = ""; return; }
  const runs = Math.ceil(qty / (r.out || 1));
  cell.textContent = (runs > 1 ? runs + " \u00d7 " : "") + dur(forgeTime(item));
  cell.title = "Adds " + dur(runs * forgeTime(item)) + " to the queue";
}

function reindex(removed) {
  const next = new Set();
  for (const p of state.open) {
    const m = /^#(\d+)(.*)$/.exec(p);
    if (!m) continue;
    const i = +m[1];
    if (i === removed) continue;
    next.add("#" + (i > removed ? i - 1 : i) + m[2]);
  }
  state.open = next;
}

function renderTree() {
  const host = $("tree");
  host.innerHTML = "";
  if (!state.build.length) {
    host.innerHTML = '<div class="blank">Nothing here yet — search above to add your first item.</div>';
    return;
  }
  state.build.forEach((b, i) => host.appendChild(buildRow(b.item, b.qty, "#" + i, 0, i)));
}

/* Update numbers in place so a box you're typing in keeps focus. */
function quantities() {
  const map = {};
  const visit = (item, qty, path) => {
    map[path] = qty;
    const r = RECIPES[item];
    if (!r || !state.open.has(path)) return;
    const runs = Math.ceil(qty / (r.out || 1));
    for (const [ing, n] of r.ing) visit(ing, runs * n, path + "|" + ing);
  };
  state.build.forEach((b, i) => visit(b.item, b.qty, "#" + i));
  return map;
}

function refreshNumbers() {
  const map = quantities();
  document.querySelectorAll(".trow").forEach(row => {
    const { path, item } = row.dataset;
    if (map[path] == null) return;
    const qty = map[path];
    const qcell = row.querySelector(".qty");
    if (!qcell.querySelector("input")) qcell.textContent = fmt(qty) + "\u00d7";
    row.querySelector(".cost").textContent = money(subCost(item, qty, path));
    const tcell = row.querySelector(".time");
    if (tcell) setTimeCell(tcell, item, qty, path);
  });
}

function renderCrew() {
  const host = $("crew");
  host.innerHTML = "";
  if (!state.players.length) {
    host.innerHTML = '<div class="blank">Add someone to get a finish time.</div>';
    return;
  }
  state.players.forEach((p, i) => {
    const row = el("div", "prow");

    const nm = el("input");
    nm.type = "text"; nm.value = p.name; nm.placeholder = "Name";
    nm.addEventListener("input", () => { p.name = nm.value; save(); });

    const qf = el("select");
    for (let l = 0; l <= 20; l++) {
      const o = el("option");
      o.value = l;
      o.textContent = l === 0 ? "not unlocked" : `level ${l} — ${qfCut(l)}%`;
      qf.appendChild(o);
    }
    qf.value = p.qf;
    qf.addEventListener("change", () => { p.qf = +qf.value; renderStats(); save(); });

    const slots = el("input");
    slots.type = "number"; slots.min = "0"; slots.max = "7"; slots.value = p.slots;
    slots.addEventListener("input", () => { p.slots = Math.max(0, +slots.value || 0); renderStats(); save(); });

    const kill = el("button", "x");
    kill.textContent = "\u00d7"; kill.title = "Remove this player";
    kill.addEventListener("click", () => { state.players.splice(i, 1); renderCrew(); renderStats(); save(); });

    row.append(nm, qf, slots, kill);
    host.appendChild(row);
  });
}

function renderTimes() {
  const host = $("times");
  const used = [...compute().used].sort();
  if (!used.length) {
    host.innerHTML = '<div class="blank">Open something in step 2 and its forge time shows up here.</div>';
    return;
  }
  host.innerHTML = "";
  for (const item of used) {
    const row = el("div", "trow-time");
    const label = el("span");
    label.textContent = item; label.title = item;
    const input = el("input");
    input.type = "text"; input.value = dur(forgeTime(item));
    input.addEventListener("change", () => {
      const secs = parseDur(input.value);
      if (secs == null) { input.classList.add("bad"); return; }
      input.classList.remove("bad");
      state.times[item] = secs;
      input.value = dur(secs);
      refreshNumbers(); renderStats(); save();
    });
    row.append(label, input);
    host.appendChild(row);
  }
}

function renderShopping() {
  const acc = compute();
  const host = $("shopping");
  const rows = Object.entries(acc.buy)
    .sort((a, b) => ((state.prices[b[0]] || 0) * b[1]) - ((state.prices[a[0]] || 0) * a[1]));
  if (!rows.length) { host.innerHTML = '<div class="blank">Nothing to buy yet.</div>'; return; }

  let html = '<table class="buy"><thead><tr><th>Item</th><th>How many</th><th>Price each</th><th>Total</th></tr></thead><tbody>';
  for (const [item, q] of rows) {
    const p = state.prices[item];
    html += `<tr><td>${item}${BAZAAR.has(item) ? "" : ' <span class="tag">auction</span>'}</td>`
      + `<td>${fmt(q)}</td>`
      + `<td>${p == null ? '<span style="color:var(--bad)">needs a price</span>' : fmt(p)}</td>`
      + `<td>${p == null ? "—" : money(p * q)}</td></tr>`;
  }
  html += `</tbody><tfoot><tr><td>Total</td><td></td><td></td><td>${money(acc.materials)}</td></tr></tfoot></table>`;
  if (acc.coins) html += `<p class="card-sub" style="margin-top:9px">Plus ${fmt(acc.coins)} coins paid straight into the forge.</p>`;
  host.innerHTML = html;
}

const statRow = (k, v, cls = "") => `<div class="s"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;

function renderStats() {
  const acc = compute();
  const cap = capacity();
  const wall = cap > 0 ? acc.forgeSeconds / cap : Infinity;
  const hours = cap > 0 ? wall / 3600 : 0;

  const bin = state.bin || 0, tax = (state.tax || 0) / 100;
  const afterTax = bin * (1 - tax) - acc.total;
  const beforeTax = bin - acc.total;

  $("timeStats").innerHTML =
    statRow("Forge runs to queue", fmt(acc.processes)) +
    statRow("Forge time, one slot", dur(acc.forgeSeconds)) +
    statRow("Crew capacity", cap ? cap.toFixed(2) + " slots' worth" : "nobody forging") +
    statRow("Everything done in", cap ? dur(wall) : "never", "big") +
    statRow("That's in days", cap ? (wall / 86400).toFixed(2) : "—");

  $("profitStats").innerHTML =
    statRow("What it costs you", money(acc.total), "gold") +
    statRow("Profit before tax", money(beforeTax), beforeTax >= 0 ? "good" : "bad") +
    statRow("Profit after tax", money(afterTax), afterTax >= 0 ? "good" : "bad") +
    statRow("Profit per hour", hours > 0 ? money(afterTax / hours) : "—", afterTax >= 0 ? "good" : "bad") +
    statRow("Profit per day", hours > 0 ? money(afterTax / (hours / 24)) : "—", afterTax >= 0 ? "good" : "bad");

  $("scoreboard").innerHTML =
    score("Total cost", money(acc.total), "gold") +
    score("Ready in", cap ? dur(wall) : "—", "ember") +
    score("Profit after tax", bin ? money(afterTax) : "—", bin ? (afterTax >= 0 ? "good" : "bad") : "") +
    (acc.missing ? score("Still unpriced", acc.missing + " item" + (acc.missing > 1 ? "s" : ""), "bad") : "");
}
const score = (k, v, cls) => `<div class="score"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;

function render() {
  renderTree(); renderTimes(); renderShopping(); renderStats(); save();
}

/* ------------------------------------------------------------------ prices */
$("fetchBz").addEventListener("click", async () => {
  const status = $("bzStatus");
  const btn = $("fetchBz");
  btn.disabled = true;
  status.textContent = "Asking the server for Bazaar prices…";
  try {
    const res = await fetch("/api/prices?mode=" + $("bzMode").value);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "the Bazaar didn't answer");
    Object.assign(state.prices, body.prices);
    const n = Object.keys(body.prices).length;
    status.textContent = `Filled ${n} prices. Auction-only items are marked in the shopping list — set those yourself.`;
    render();
  } catch (err) {
    status.textContent = "Couldn't get prices: " + err.message + ". Type them in by hand, or try again in a moment.";
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ export */
$("copyTsv").addEventListener("click", () => {
  const acc = compute();
  const lines = ["Item\tCount\tPrice per item\tTotal cost"];
  for (const [item, q] of Object.entries(acc.buy))
    lines.push(`${item}\t${q}\t${state.prices[item] ?? ""}\t${(state.prices[item] || 0) * q}`);
  lines.push(`Total\t\t\t${acc.total}`);
  const text = lines.join("\n");
  const done = () => {
    $("copyTsv").textContent = "Copied";
    setTimeout(() => ($("copyTsv").textContent = "Copy for Sheets"), 1500);
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => window.prompt("Copy this:", text));
  else window.prompt("Copy this:", text);
});

/* ------------------------------------------------------------- persistence */
const KEY = "forge-planner";
const snapshot = () => ({
  build: state.build, open: [...state.open], prices: state.prices, times: state.times,
  players: state.players, cole: state.cole, bin: state.bin, tax: state.tax,
});

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(snapshot())); } catch (e) { /* private mode, no matter */ }
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    state.build = s.build || [];
    state.open = new Set(s.open || []);
    state.prices = s.prices || {};
    state.times = s.times || {};
    state.players = s.players || [];
    state.cole = !!s.cole;
    state.bin = s.bin || 0;
    state.tax = s.tax ?? 2.5;
    return true;
  } catch (e) { return false; }
}

/* --------------------------------------------------------------- wire it up */
$("search").addEventListener("input", runSearch);
$("search").addEventListener("focus", runSearch);
$("search").addEventListener("keydown", e => {
  if ($("results").hidden || !matches.length) return;
  if (e.key === "ArrowDown") { sel = (sel + 1) % matches.length; highlight(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sel = (sel - 1 + matches.length) % matches.length; highlight(); e.preventDefault(); }
  else if (e.key === "Enter") { addItem(matches[sel]); e.preventDefault(); }
  else if (e.key === "Escape") { $("results").hidden = true; }
});
$("results").addEventListener("mousedown", e => {
  const opt = e.target.closest("[data-i]");
  if (!opt) return;
  e.preventDefault();
  addItem(matches[+opt.dataset.i]);
});
document.addEventListener("click", e => {
  if (!e.target.closest(".searchbox")) $("results").hidden = true;
});

$("addPlayer").addEventListener("click", () => {
  state.players.push({ name: "Coop " + state.players.length, qf: 0, slots: 5 });
  renderCrew(); renderStats(); save();
});
$("cole").addEventListener("change", e => { state.cole = e.target.checked; renderStats(); save(); });
$("bin").addEventListener("input", e => { state.bin = parseFloat(e.target.value) || 0; renderStats(); save(); });
$("tax").addEventListener("input", e => { state.tax = parseFloat(e.target.value) || 0; renderStats(); save(); });

(async function start() {
  try {
    const res = await fetch("/api/recipes");
    const body = await res.json();
    RECIPES = body.recipes;
    CATEGORIES = body.categories || [];
    BAZAAR = new Set(body.bazaar || []);
  } catch (err) {
    $("tree").innerHTML = '<div class="blank">Couldn\'t load the recipe list from the server. Refresh the page.</div>';
    return;
  }
  load();
  $("cole").checked = state.cole;
  $("bin").value = state.bin || "";
  $("tax").value = state.tax;
  renderCrew();
  render();
})();
