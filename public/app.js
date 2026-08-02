/* ---------------------------------------------------------------------------
   Front end. Recipes arrive from /api/recipes, prices from /api/prices.
   Everything below is display and arithmetic.
--------------------------------------------------------------------------- */
"use strict";

let RECIPES = {}, CATEGORIES = [], BAZAAR = new Set(), AUCTION = new Set(), AUCTION_TAGS = {};

const state = {
  build: [],          // [{item, qty}]
  open: new Set(),    // paths of the rows you've opened, e.g. "#0|Mithril Plate"
  prices: {},         // item -> coins each
  manual: new Set(),  // items whose price you typed yourself
  times: {},          // item -> corrected forge seconds
  players: [{ id: 1, name: "You", qf: 20, slots: 5 }],
  assign: {},         // item -> player id, or absent for "anyone"
  cole: false,
  sell: {},           // item -> what one sells for
  tax: 2.5,
  sortBuy: { key: "total", dir: -1 },
  sortForge: { key: "real", dir: -1 },
  autoPrice: true,
  zoom: 1,
};
let scrubAt = null;        // seconds into the build, or null when not hovering
let scrubLocked = false;
let lastPlan = null;
let nextPlayerId = 2;

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
function walk(item, qty, path, acc, parentForge = null) {
  const r = RECIPES[item];
  if (!r || !state.open.has(path)) {
    acc.buy[item] = (acc.buy[item] || 0) + qty;
    return;
  }
  const runs = Math.ceil(qty / (r.out || 1));
  let nextParent = parentForge;

  if (r.craft) {
    acc.crafted[item] = (acc.crafted[item] || 0) + runs;
  } else {
    acc.forgeSeconds += runs * forgeTime(item);
    acc.processes += runs;
    acc.used.add(item);
    acc.runsPer[item] = (acc.runsPer[item] || 0) + runs;
    /* whatever forge job sits above this one has to wait for it */
    if (parentForge) {
      (acc.deps[parentForge] ||= new Set()).add(item);
      (acc.needs[parentForge] ||= {})[item] = ((acc.needs[parentForge] || {})[item] || 0) + qty;
    }
    acc.deps[item] ||= new Set();
    nextParent = item;
  }

  if (r.coins) acc.coins += runs * r.coins;
  for (const [ing, n] of r.ing) walk(ing, runs * n, path + "|" + ing, acc, nextParent);
}

const blank = () => ({ buy: {}, forgeSeconds: 0, processes: 0, coins: 0,
  used: new Set(), runsPer: {}, crafted: {}, deps: {}, needs: {} });

function compute() {
  const acc = blank();
  state.build.forEach((b, i) => walk(b.item, b.qty, "#" + i, acc, null));
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
const playerCap = p => (p.slots || 0) / (1 - reduction(p.qf || 0));
const capacity = () => state.players.reduce((s, p) => s + playerCap(p), 0);
const playerById = id => state.players.find(p => p.id === id);

/* What the forge actually has to chew through: one entry per forged item. */
function queueRows() {
  const acc = compute();
  const rows = [];
  for (const [item, runs] of Object.entries(acc.runsPer)) {
    const each = forgeTime(item);
    const owner = playerById(state.assign[item]);
    rows.push({ item, runs, each, work: runs * each, owner: owner || null });
  }
  return rows;
}

/* ------------------------------------------------------------- scheduling */
/* A forge run occupies one slot for its whole duration — it can't be split
   across slots. So this is a scheduling problem, not a division: lay every
   run into a slot, and the build finishes when the busiest slot finishes.

   Slots differ in speed. A slot belonging to someone with Quick Forge 20 and
   Cole in office runs at 55% off, so the same run takes less wall time there.

   Method: longest run first, each one dropped into whichever slot would
   finish it earliest, then a swap pass to shave the bottleneck. That's the
   standard approach for this and lands very close to optimal. */

const MAX_JOBS = 20000;

function slotList() {
  const out = [];
  for (const p of state.players) {
    const red = reduction(p.qf || 0);
    for (let i = 0; i < (p.slots || 0); i++)
      out.push({ key: p.id + "#" + i, player: p, red, n: i + 1, intervals: [], end: 0, tally: {} });
  }
  return out;
}

/* Earliest moment this slot could start a job of length d, no sooner than
   `est`, without clashing with what's already booked. Gaps get reused. */
function earliestFit(slot, est, d) {
  let t = est;
  for (const iv of slot.intervals) {
    if (t + d <= iv.start + 1e-9) return t;
    if (iv.end > t) t = iv.end;
  }
  return t;
}

function book(slot, item, start, d) {
  const iv = { item, start, end: start + d };
  const at = slot.intervals.findIndex(x => x.start > start);
  if (at === -1) slot.intervals.push(iv); else slot.intervals.splice(at, 0, iv);
  slot.end = Math.max(slot.end, iv.end);
  slot.tally[item] = (slot.tally[item] || 0) + 1;
  return iv;
}

/* A forge run holds one slot for its whole duration, and it can't begin until
   the parts it consumes have come out of the forge. So the plan is a
   precedence-constrained schedule: work out the order things unlock in, then
   for each job pick the slot and moment that finishes it soonest. */
function buildPlan() {
  const slots = slotList();
  const acc = compute();
  const runsPer = acc.runsPer;
  const items = Object.keys(runsPer);

  if (!slots.length || !items.length)
    return { slots, makespan: items.length ? Infinity : 0, spans: [], truncated: false, unplaceable: [], base: {} };

  const base = {};
  for (const item of items) base[item] = forgeTime(item);

  /* how deep in the dependency chain each item sits — children first */
  const depth = {};
  const measure = (item, seen = new Set()) => {
    if (depth[item] != null) return depth[item];
    if (seen.has(item)) return 0;                    // guard, shouldn't happen
    seen.add(item);
    let d = 0;
    for (const child of acc.deps[item] || []) d = Math.max(d, measure(child, seen) + 1);
    return (depth[item] = d);
  };
  items.forEach(i => measure(i));

  const order = items.slice().sort((a, b) =>
    depth[a] - depth[b] || (runsPer[b] * base[b]) - (runsPer[a] * base[a]));

  const done = {};            // item -> when its last run finishes
  const spans = [];
  const unplaceable = new Set();
  let scheduled = 0, truncated = false;

  for (const item of order) {
    const ready = [...(acc.deps[item] || [])].reduce((t, child) => Math.max(t, done[child] || 0), 0);
    const owner = state.assign[item];
    const pool = owner == null ? slots : slots.filter(s2 => s2.player.id === owner);

    if (!pool.length) { unplaceable.add(item); done[item] = ready; continue; }

    let first = Infinity, last = ready;
    for (let k = 0; k < runsPer[item]; k++) {
      if (scheduled >= MAX_JOBS) { truncated = true; break; }
      let best = null, bestStart = 0, bestEnd = Infinity;
      for (const slot of pool) {
        const d = base[item] * (1 - slot.red);
        const t = earliestFit(slot, ready, d);
        if (t + d < bestEnd - 1e-9) { best = slot; bestStart = t; bestEnd = t + d; }
      }
      book(best, item, bestStart, bestEnd - bestStart);
      first = Math.min(first, bestStart);
      last = Math.max(last, bestEnd);
      scheduled++;
    }
    done[item] = last;
    spans.push({ item, runs: runsPer[item], start: isFinite(first) ? first : ready, end: last, depth: depth[item] });
    if (truncated) break;
  }

  const makespan = slots.reduce((m, s2) => Math.max(m, s2.end), 0);
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return { slots, makespan, spans, truncated, unplaceable: [...unplaceable], base };
}

const finishTime = () => buildPlan().makespan;

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
    if (input.value === "") { delete state.prices[item]; state.manual.delete(item); }
    else { state.prices[item] = parseFloat(input.value) || 0; state.manual.add(item); }
    document.querySelectorAll("input[data-price-for]").forEach(o => {
      if (o.dataset.priceFor !== item || o === input) return;
      o.value = state.prices[item] ?? "";
      o.classList.toggle("unset", state.prices[item] == null);
    });
    input.classList.toggle("unset", state.prices[item] == null);
    refreshNumbers(); renderShopping(); renderQueue(); renderPlan(); renderStats(); save();
  });
  wrap.appendChild(input);
  return wrap;
}

function buildRow(item, qty, path, depth, rootIdx) {
  const frag = document.createDocumentFragment();
  const r = RECIPES[item];
  const open = state.open.has(path);

  const row = el("div", "trow " + (open ? (r.craft ? "crafting" : "forging") : r ? "buying" : "leaf"));
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
    chev.className = "chev" + (open ? (r.craft ? " on craft" : " on") : "");
    chev.textContent = open ? "▼" : "▶";
    chev.setAttribute("aria-expanded", String(open));
    chev.title = open
      ? (r.craft ? "Crafting this yourself — instant, no forge slot. Close to buy it instead."
                 : "Forging this from its parts. Close to buy it instead.")
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
      refreshNumbers(); renderShopping(); renderQueue(); renderPlan();
      renderSell(); renderStats(); save();
    });
    q.appendChild(qi);
  } else {
    q.textContent = fmt(qty) + "\u00d7";
  }
  row.appendChild(q);

  /* price each */
  if (open) {
    const fixed = el("div", "pcell");
    fixed.innerHTML = `<div class="fixed">${r.craft ? "crafted" : "forged"}</div>`;
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
    nm.addEventListener("input", () => { p.name = nm.value; renderQueue(); save(); });

    const qf = el("select");
    for (let l = 0; l <= 20; l++) {
      const o = el("option");
      o.value = l;
      o.textContent = l === 0 ? "not unlocked" : `level ${l} — ${qfCut(l)}%`;
      qf.appendChild(o);
    }
    qf.value = p.qf;
    qf.addEventListener("change", () => { p.qf = +qf.value; renderQueue(); renderPlan(); renderStats(); save(); });

    const slots = el("input");
    slots.type = "number"; slots.min = "0"; slots.max = "7"; slots.value = p.slots;
    slots.addEventListener("input", () => { p.slots = Math.max(0, +slots.value || 0); renderQueue(); renderPlan(); renderStats(); save(); });

    const kill = el("button", "x");
    kill.textContent = "\u00d7"; kill.title = "Remove this player";
    kill.addEventListener("click", () => {
      const gone = p.id;
      state.players.splice(i, 1);
      for (const [item, id] of Object.entries(state.assign)) if (id === gone) delete state.assign[item];
      renderCrew(); renderQueue(); renderPlan(); renderStats(); save();
    });

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
      refreshNumbers(); renderQueue(); renderPlan(); renderStats(); save();
    });
    row.append(label, input);
    host.appendChild(row);
  }
}

/* Both lists share the same sortable-header behaviour. */
function sortHeader(cols, sortState, onSort) {
  const tr = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    if (c.key) {
      th.className = "sortable" + (sortState.key === c.key ? " active" : "");
      th.tabIndex = 0;
      th.innerHTML = `${c.label}<span class="arrow">${
        sortState.key === c.key ? (sortState.dir === -1 ? "\u25be" : "\u25b4") : "\u21c5"}</span>`;
      const go = () => {
        if (sortState.key === c.key) sortState.dir *= -1;
        else { sortState.key = c.key; sortState.dir = -1; }   // new column starts high to low
        onSort();
      };
      th.addEventListener("click", go);
      th.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    } else {
      th.textContent = c.label;
    }
    if (c.right) th.classList.add("r");
    tr.appendChild(th);
  }
  return tr;
}

function sortRows(rows, { key, dir }) {
  return rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === "string") return dir * x.localeCompare(y);
    const ax = x == null || !isFinite(x) ? -Infinity : x;
    const by = y == null || !isFinite(y) ? -Infinity : y;
    return dir * (ax - by);
  });
}

function renderShopping() {
  const acc = compute();
  const host = $("shopping");
  host.innerHTML = "";

  const rows = Object.entries(acc.buy).map(([item, count]) => ({
    item, count,
    each: state.prices[item] ?? null,
    total: state.prices[item] != null ? state.prices[item] * count : null,
  }));

  if (!rows.length) { host.innerHTML = '<div class="blank">Nothing to buy — you\'re forging all of it.</div>'; return; }

  const table = document.createElement("table");
  table.className = "grid";
  const thead = document.createElement("thead");
  thead.appendChild(sortHeader([
    { label: "Item", key: "item" },
    { label: "How many", key: "count", right: true },
    { label: "Price each", key: "each", right: true },
    { label: "Total", key: "total", right: true },
  ], state.sortBuy, renderShopping));
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of sortRows(rows, state.sortBuy)) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${r.item}${AUCTION.has(r.item) ? ' <span class="tag ah">AH</span>' : ""}</td>` +
      `<td class="r n">${fmt(r.count)}</td>` +
      `<td class="r n">${r.each == null ? '<span class="need">no price</span>' : fmt(r.each)}</td>` +
      `<td class="r n gold">${r.total == null ? "\u2014" : money(r.total)}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  tfoot.innerHTML = `<tr><td>Total</td><td></td><td></td><td class="r n gold">${money(acc.materials)}</td></tr>`;
  table.appendChild(tfoot);

  host.appendChild(table);
  if (acc.coins) {
    const p = document.createElement("p");
    p.className = "card-sub";
    p.style.marginTop = "9px";
    p.textContent = `Plus ${fmt(acc.coins)} coins paid straight into the forge.`;
    host.appendChild(p);
  }
}

function renderQueue() {
  const host = $("queue");
  host.innerHTML = "";
  const rows = queueRows().map(r => {
    /* how long this item alone would take on the slots available to it,
       spread as evenly as whole runs allow */
    const pool = r.owner
      ? slotList().filter(s => s.player.id === r.owner.id)
      : slotList();
    if (!pool.length) return { ...r, real: Infinity };
    const ends = pool.map(() => 0);
    const reds = pool.map(s => s.red);
    for (let i = 0; i < r.runs; i++) {
      let b = 0;
      for (let j = 1; j < ends.length; j++)
        if (ends[j] + r.each * (1 - reds[j]) < ends[b] + r.each * (1 - reds[b])) b = j;
      ends[b] += r.each * (1 - reds[b]);
    }
    return { ...r, real: Math.max(...ends) };
  });
  if (!rows.length) { host.innerHTML = '<div class="blank">Nothing in the forge — open a row in step 2.</div>'; return; }

  const table = document.createElement("table");
  table.className = "grid";
  const thead = document.createElement("thead");
  thead.appendChild(sortHeader([
    { label: "Item", key: "item" },
    { label: "Runs", key: "runs", right: true },
    { label: "Per run", key: "each", right: true },
    { label: "All runs", key: "work", right: true },
    { label: "Real time", key: "real", right: true },
    { label: "Forged by" },
  ], state.sortForge, renderQueue));
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of sortRows(rows, state.sortForge)) {
    const tr = document.createElement("tr");

    const name = document.createElement("td");
    name.textContent = r.item;
    tr.appendChild(name);

    for (const v of [fmt(r.runs), dur(r.each), dur(r.work)]) {
      const td = document.createElement("td");
      td.className = "r n";
      td.textContent = v;
      tr.appendChild(td);
    }

    const real = document.createElement("td");
    real.className = "r n ember";
    real.textContent = isFinite(r.real) ? dur(r.real) : "\u2014";
    real.title = r.owner
      ? `${r.owner.name}: ${r.owner.slots} slot${r.owner.slots === 1 ? "" : "s"}, ${Math.round(reduction(r.owner.qf) * 100)}% off`
      : `Shared across all ${state.players.length} of you`;
    tr.appendChild(real);

    const who = document.createElement("td");
    const pick = document.createElement("select");
    pick.className = "who";
    const any = document.createElement("option");
    any.value = ""; any.textContent = "Anyone";
    pick.appendChild(any);
    for (const p of state.players) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name || "unnamed";
      pick.appendChild(o);
    }
    pick.value = state.assign[r.item] ?? "";
    pick.addEventListener("change", () => {
      if (pick.value === "") delete state.assign[r.item];
      else state.assign[r.item] = +pick.value;
      renderQueue(); renderPlan(); renderStats(); save();
    });
    who.appendChild(pick);
    tr.appendChild(who);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const totalWork = rows.reduce((s, r) => s + r.work, 0);
  const tfoot = document.createElement("tfoot");
  tfoot.innerHTML =
    `<tr><td>Everything</td><td class="r n">${fmt(rows.reduce((s, r) => s + r.runs, 0))}</td>` +
    `<td></td><td class="r n">${dur(totalWork)}</td>` +
    `<td class="r n ember">${dur(finishTime())}</td><td></td></tr>`;
  table.appendChild(tfoot);

  host.appendChild(table);
}

function renderSell() {
  const host = $("sellRows");
  host.innerHTML = "";
  if (!state.build.length) { host.innerHTML = '<div class="blank">Add something in step 1 first.</div>'; return; }
  const seen = new Set();
  for (const b of state.build) {
    if (seen.has(b.item)) continue;
    seen.add(b.item);
    const row = document.createElement("div");
    row.className = "sellrow";
    const label = document.createElement("span");
    label.textContent = b.item;
    label.title = b.item;
    const qty = document.createElement("span");
    qty.className = "n dim";
    qty.textContent = "\u00d7" + fmt(state.build.filter(x => x.item === b.item).reduce((s2, x) => s2 + x.qty, 0));
    const input = document.createElement("input");
    input.type = "number"; input.min = "0"; input.placeholder = "sells for";
    if (state.sell[b.item] != null) input.value = state.sell[b.item];
    input.addEventListener("input", () => {
      if (input.value === "") delete state.sell[b.item];
      else state.sell[b.item] = parseFloat(input.value) || 0;
      renderStats(); save();
    });
    row.append(label, qty, input);
    host.appendChild(row);
  }
}

const statRow = (k, v, cls = "") => `<div class="s"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;

function renderStats() {
  const acc = compute();
  const cap = capacity();
  const wall = finishTime();
  const hours = isFinite(wall) ? wall / 3600 : 0;

  const tax = (state.tax || 0) / 100;
  let revenue = 0, priced = false;
  for (const b of state.build) {
    const each = state.sell[b.item];
    if (each == null) continue;
    revenue += each * b.qty;
    priced = true;
  }
  const beforeTax = revenue - acc.total;
  const afterTax = revenue * (1 - tax) - acc.total;

  $("timeStats").innerHTML =
    statRow("Forge runs to queue", fmt(acc.processes)) +
    statRow("Forge time, one slot", dur(acc.forgeSeconds)) +
    statRow("Crew capacity", cap ? cap.toFixed(2) + " slots' worth" : "nobody forging") +
    statRow("Everything done in", isFinite(wall) ? dur(wall) : "never", "big") +
    statRow("That's in days", isFinite(wall) ? (wall / 86400).toFixed(2) : "—");

  $("profitStats").innerHTML =
    statRow("What it all sells for", priced ? money(revenue) : "\u2014") +
    statRow("What it costs you", money(acc.total), "gold") +
    statRow("Profit before tax", priced ? money(beforeTax) : "\u2014", beforeTax >= 0 ? "good" : "bad") +
    statRow("Profit after tax", priced ? money(afterTax) : "\u2014", afterTax >= 0 ? "good" : "bad") +
    statRow("Profit per hour", priced && hours > 0 ? money(afterTax / hours) : "\u2014", afterTax >= 0 ? "good" : "bad") +
    statRow("Profit per day", priced && hours > 0 ? money(afterTax / (hours / 24)) : "\u2014", afterTax >= 0 ? "good" : "bad");

  $("scoreboard").innerHTML =
    score("Total cost", money(acc.total), "gold") +
    score("Ready in", isFinite(wall) ? dur(wall) : "—", "ember") +
    score("Profit after tax", priced ? money(afterTax) : "\u2014", priced ? (afterTax >= 0 ? "good" : "bad") : "") +
    (acc.missing ? score("Still unpriced", acc.missing + " item" + (acc.missing > 1 ? "s" : ""), "bad") : "");
}
const score = (k, v, cls) => `<div class="score"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;

/* What you'd be holding, and what's mid-forge, at a given moment. */
function snapshotAt(plan, t) {
  const acc = compute();
  const produced = {}, started = {}, busy = [];
  for (const slot of plan.slots) {
    for (const iv of slot.intervals) {
      if (iv.end <= t + 1e-6) produced[iv.item] = (produced[iv.item] || 0) + (RECIPES[iv.item].out || 1);
      if (iv.start <= t + 1e-6) started[iv.item] = (started[iv.item] || 0) + 1;
      if (iv.start <= t && t < iv.end) busy.push({ slot, iv, left: iv.end - t });
    }
  }
  /* a run takes its ingredients the moment it starts */
  const consumed = {};
  for (const [parent, parts] of Object.entries(acc.needs || {})) {
    const totalRuns = acc.runsPer[parent];
    if (!totalRuns) continue;
    const ran = started[parent] || 0;
    for (const [part, qty] of Object.entries(parts))
      consumed[part] = (consumed[part] || 0) + (qty / totalRuns) * ran;
  }
  const held = [];
  for (const item of new Set([...Object.keys(produced), ...Object.keys(consumed)])) {
    const n = (produced[item] || 0) - (consumed[item] || 0);
    if (n > 0.004) held.push({ item, n });
  }
  held.sort((a, b) => b.n - a.n || a.item.localeCompare(b.item));
  busy.sort((a, b) => a.left - b.left);
  return { held, busy };
}

function renderScrub() {
  const board = $("plan").querySelector(".slots-card");
  if (!board || !lastPlan) return;
  const head = board.querySelector(".playhead");
  const out = $("scrubOut");
  if (!head || !out) return;

  if (scrubAt == null) {
    head.style.display = "none";
    out.innerHTML = '<span class="hint">Point at the slot chart to see where things stand at that moment. Click to pin it.</span>';
    return;
  }

  const anyBar = board.querySelector(".timeline");
  const track = board.querySelector(".track");
  if (!anyBar || !track) return;
  const barBox = anyBar.getBoundingClientRect();
  const trackBox = track.getBoundingClientRect();
  const frac = scrubAt / lastPlan.makespan;
  head.style.display = "block";
  head.style.left = (barBox.left - trackBox.left + frac * barBox.width) + "px";

  const { held, busy } = snapshotAt(lastPlan, scrubAt);
  out.innerHTML =
    `<div class="scrub-head"><span class="at">${dur(scrubAt)} in</span>` +
    `<span class="pin">${scrubLocked ? "pinned — click again to release" : "click to pin"}</span></div>` +
    `<div class="scrub-cols">
       <div>
         <span class="eyebrow">In the forge (${busy.length})</span>
         ${busy.length ? busy.map(b =>
            `<div class="scrub-line"><i class="swatch" style="background:${itemColour(b.iv.item)}"></i>` +
            `<span>${b.iv.item}</span><b>${b.slot.player.name || "?"} slot ${b.slot.n}</b>` +
            `<em>${dur(b.left)} left</em></div>`).join("")
          : '<div class="scrub-line empty">every slot idle</div>'}
       </div>
       <div>
         <span class="eyebrow">Sitting in your inventory (${held.length})</span>
         ${held.length ? held.map(h =>
            `<div class="scrub-line"><i class="swatch" style="background:${itemColour(h.item)}"></i>` +
            `<span>${h.item}</span><em>${fmt(h.n)}</em></div>`).join("")
          : '<div class="scrub-line empty">nothing finished yet</div>'}
       </div>
     </div>`;
}

/* A stable colour per item so the same job looks the same in every slot. */
function itemHue(item) {
  let h = 0;
  for (let i = 0; i < item.length; i++) h = (h * 31 + item.charCodeAt(i)) % 360;
  return h;
}
const itemColour = item => `hsl(${itemHue(item)} 62% 55%)`;

function timeAxis(makespan) {
  const axis = el("div", "axis");
  const inner = el("div", "axis-in");
  const steps = Math.min(12, Math.max(4, Math.round(4 * state.zoom)));
  for (let i = 0; i <= steps; i++) {
    const tick = el("span");
    tick.style.left = (i / steps) * 100 + "%";
    tick.textContent = i === 0 ? "start" : dur((makespan * i) / steps);
    inner.appendChild(tick);
  }
  axis.appendChild(el("div"));
  axis.appendChild(inner);
  axis.appendChild(el("div"));
  return axis;
}

/* One bar of coloured segments, positioned against the whole build's length. */
function timeline(intervals, makespan, opts = {}) {
  const bar = el("div", "timeline" + (opts.hot ? " hot" : ""));
  for (const iv of intervals) {
    const seg = el("i");
    const width = ((iv.end - iv.start) / makespan) * 100;
    seg.style.left = (iv.start / makespan) * 100 + "%";
    seg.style.width = Math.max(width, 0.2) + "%";
    seg.style.background = itemColour(iv.item);
    seg.title = `${iv.item} — ${iv.start < 1 ? "from the start" : dur(iv.start)} to ${dur(iv.end)} (${dur(iv.end - iv.start)})`;
    if (width * state.zoom > 9) {
      const tag = el("b");
      tag.textContent = iv.item;
      seg.appendChild(tag);
    }
    bar.appendChild(seg);
  }
  return bar;
}

function scroller(makespan) {
  const wrap = el("div", "scroller");
  const track = el("div", "track");
  track.style.width = (state.zoom * 100) + "%";
  track.appendChild(timeAxis(makespan));
  wrap.appendChild(track);
  return { wrap, track };
}

function zoomBar() {
  const bar = el("div", "zoombar");
  const label = el("span", "zlabel");
  label.textContent = state.zoom.toFixed(state.zoom < 10 ? 1 : 0) + "\u00d7";

  const set = z => {
    state.zoom = Math.min(64, Math.max(1, z));
    save();
    renderPlan();
  };
  const mk = (text, title, fn) => {
    const b = el("button", "zbtn");
    b.textContent = text; b.title = title;
    b.addEventListener("click", fn);
    return b;
  };
  bar.append(
    el("span", "zoom-eyebrow"),
    mk("\u2212", "Zoom out", () => set(state.zoom / 2)),
    label,
    mk("+", "Zoom in", () => set(state.zoom * 2)),
    mk("fit", "Back to the whole build", () => set(1)),
  );
  bar.firstChild.textContent = "Zoom";
  return bar;
}

function renderPlan() {
  const host = $("plan");
  host.innerHTML = "";
  const plan = buildPlan();
  lastPlan = plan;

  if (!plan.slots.length) {
    host.innerHTML = '<div class="card"><div class="blank">Nobody has any slots. Add a player in step 4.</div></div>';
    return;
  }
  if (!isFinite(plan.makespan) || plan.makespan === 0) {
    host.innerHTML = '<div class="card"><div class="blank">Nothing to forge yet — open a row in step 2.</div></div>';
    return;
  }

  const hottest = plan.slots.reduce((m, s2) => (s2.end > m.end ? s2 : m), plan.slots[0]);

  const bar = el("div", "plan-bar");
  const facts = el("div", "plan-facts");
  facts.innerHTML =
    `<div><span class="k">Finishes in</span><span class="v ember">${dur(plan.makespan)}</span></div>` +
    `<div><span class="k">That's</span><span class="v">${(plan.makespan / 86400).toFixed(2)} days</span></div>` +
    `<div><span class="k">Slots working</span><span class="v">${plan.slots.filter(s2 => s2.end > 0).length} of ${plan.slots.length}</span></div>` +
    `<div><span class="k">Last to finish</span><span class="v">${hottest.player.name || "someone"}, slot ${hottest.n}</span></div>`;
  bar.appendChild(facts);
  bar.appendChild(zoomBar());
  host.appendChild(bar);

  for (const text of [
    plan.unplaceable.length ? `Assigned to someone with no slots: ${plan.unplaceable.join(", ")}. Give them slots in step 4, or set those back to Anyone.` : "",
    plan.truncated ? "More than 20,000 forge runs — the plan below covers as many as it could fit." : "",
  ]) if (text) { const w = el("p", "warn"); w.textContent = text; host.appendChild(w); }

  /* ---- the whole build, one row per item, in the order things unlock ---- */
  const overview = el("div", "card");
  const oh = el("h3", "card-title");
  oh.textContent = "What unlocks when";
  overview.appendChild(oh);
  const osub = el("p", "card-sub");
  osub.textContent = "Nothing here can start until the parts above it are out of the forge.";
  overview.appendChild(osub);

  const ov = scroller(plan.makespan);
  for (const span of plan.spans) {
    const row = el("div", "span-row");
    const name = el("div", "span-name");
    name.innerHTML = `<i class="swatch" style="background:${itemColour(span.item)}"></i>` +
                     `<span class="nm">${span.item}</span><b>\u00d7${fmt(span.runs)}</b>`;
    row.appendChild(name);
    row.appendChild(timeline([{ item: span.item, start: span.start, end: span.end }], plan.makespan));
    const when = el("div", "span-time");
    when.textContent = dur(span.end);
    row.appendChild(when);
    ov.track.appendChild(row);
  }
  overview.appendChild(ov.wrap);
  host.appendChild(overview);

  /* ---- every slot you have between you ---- */
  const board = el("div", "card slots-card");
  const bh = el("h3", "card-title");
  bh.textContent = "Slot by slot";
  board.appendChild(bh);
  const bsub = el("p", "card-sub");
  bsub.textContent = "Gaps are the forge waiting on parts. Point anywhere to read that moment.";
  board.appendChild(bsub);

  const sb = scroller(plan.makespan);
  const head = el("div", "playhead");
  head.style.display = "none";
  sb.track.appendChild(head);

  for (const p2 of state.players) {
    const mine = plan.slots.filter(s2 => s2.player.id === p2.id);
    if (!mine.length) continue;

    const group = el("div", "player-group");
    const ph = el("div", "plan-head");
    const cut = Math.round(reduction(p2.qf || 0) * 100);
    ph.innerHTML =
      `<h4>${p2.name || "unnamed"}</h4>` +
      `<span class="chip">${p2.qf ? "Quick Forge " + p2.qf : "no Quick Forge"}</span>` +
      (state.cole ? '<span class="chip cole">Cole +25%</span>' : "") +
      `<span class="chip cut">${cut}% faster</span>` +
      `<span class="chip">${mine.length} slot${mine.length === 1 ? "" : "s"}</span>`;
    group.appendChild(ph);

    for (const slot of mine) {
      const row = el("div", "slot-row" + (slot === hottest ? " hot" : ""));
      const tag = el("div", "slot-n");
      tag.textContent = "Slot " + slot.n;
      row.appendChild(tag);
      row.appendChild(timeline(slot.intervals, plan.makespan, { hot: slot === hottest }));
      const time = el("div", "slot-time");
      time.textContent = slot.end ? dur(slot.end) : "idle";
      row.appendChild(time);
      group.appendChild(row);
    }
    sb.track.appendChild(group);
  }
  board.appendChild(sb.wrap);

  const readout = el("div", "scrub-out");
  readout.id = "scrubOut";
  board.appendChild(readout);
  host.appendChild(board);

  /* scrubbing */
  const posFor = e => {
    const anyBar = sb.track.querySelector(".timeline");
    if (!anyBar) return null;
    const box = anyBar.getBoundingClientRect();
    const f = (e.clientX - box.left) / box.width;
    return Math.min(1, Math.max(0, f)) * plan.makespan;
  };
  sb.wrap.addEventListener("mousemove", e => {
    if (scrubLocked) return;
    scrubAt = posFor(e);
    renderScrub();
  });
  sb.wrap.addEventListener("mouseleave", () => {
    if (scrubLocked) return;
    scrubAt = null;
    renderScrub();
  });
  sb.wrap.addEventListener("click", e => {
    if (scrubLocked) { scrubLocked = false; scrubAt = posFor(e); }
    else { scrubAt = posFor(e); scrubLocked = true; }
    renderScrub();
  });

  const note = el("p", "card-sub");
  note.style.marginTop = "10px";
  note.textContent = "Each run holds one slot for its whole length and can't start before the parts it eats are finished. Runs of the same item still go in parallel.";
  host.appendChild(note);

  renderScrub();
}

function render() {
  renderTree(); renderTimes(); renderShopping(); renderQueue();
  renderSell(); renderPlan(); renderStats(); save();
  refreshAuctionPrices();
}

/* ------------------------------------------------------------------ prices */
/* Bazaar is one cheap request, so it refreshes on a timer. Auction lookups
   cost one request per item at Coflnet, so they only run for items actually
   on the shopping list, and only when that list changes. */
let lastAuctionSet = "";
let auctionBusy = false;

function statusLine(text) { $("bzStatus").textContent = text; }

async function refreshBazaarPrices({ quiet = false } = {}) {
  if (!quiet) statusLine("Getting Bazaar prices\u2026");
  try {
    const res = await fetch("/api/prices?mode=" + $("bzMode").value);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "the Bazaar didn't answer");
    Object.assign(state.prices, body.prices);
    const when = new Date(body.fetchedAt || Date.now()).toLocaleTimeString();
    statusLine(`${Object.keys(body.prices).length} Bazaar prices, updated ${when}.`);
    redrawPrices();
    return true;
  } catch (err) {
    statusLine("Bazaar prices failed: " + err.message + ". Type prices in by hand or try again.");
    return false;
  }
}

/* Which auction-only items does the current plan actually need? */
function neededAuctionItems() {
  return Object.keys(compute().buy).filter(i => AUCTION.has(i));
}

async function refreshAuctionPrices({ force = false } = {}) {
  const items = neededAuctionItems();
  const key = items.slice().sort().join("|");
  if (!items.length) { lastAuctionSet = ""; return; }
  if (auctionBusy || (!force && key === lastAuctionSet)) return;
  auctionBusy = true;
  lastAuctionSet = key;
  try {
    const res = await fetch("/api/auction?items=" + encodeURIComponent(items.join(",")));
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "no answer");
    /* Never stomp on a price you typed in yourself. */
    for (const [item, price] of Object.entries(body.prices))
      if (!state.manual.has(item)) state.prices[item] = price;
    redrawPrices();
    if (body.failed && body.failed.length)
      statusLine(`No auction listing found for ${body.failed.join(", ")} — set those yourself.`);
  } catch (err) {
    statusLine("Auction prices failed: " + err.message);
    lastAuctionSet = "";
  } finally {
    auctionBusy = false;
  }
}

/* Repaint everything that shows a price without rebuilding the tree. */
function redrawPrices() {
  document.querySelectorAll("input[data-price-for]").forEach(input => {
    const item = input.dataset.priceFor;
    if (document.activeElement === input) return;
    input.value = state.prices[item] ?? "";
    input.classList.toggle("unset", state.prices[item] == null);
  });
  refreshNumbers(); renderShopping(); renderStats(); save();
}

$("fetchBz").addEventListener("click", async () => {
  const btn = $("fetchBz");
  btn.disabled = true;
  await refreshBazaarPrices();
  await refreshAuctionPrices({ force: true });
  btn.disabled = false;
});

$("bzMode").addEventListener("change", () => refreshBazaarPrices());

$("autoPrice").addEventListener("change", e => {
  state.autoPrice = e.target.checked;
  save();
});

setInterval(() => {
  if (state.autoPrice && !document.hidden) refreshBazaarPrices({ quiet: true });
}, 60_000);

setInterval(() => {
  if (state.autoPrice && !document.hidden) refreshAuctionPrices({ force: true });
}, 600_000);

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
  manual: [...state.manual], players: state.players, assign: state.assign,
  cole: state.cole, sell: state.sell, tax: state.tax, autoPrice: state.autoPrice,
  sortBuy: state.sortBuy, sortForge: state.sortForge, zoom: state.zoom,
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
    state.manual = new Set(s.manual || []);
    state.players = (s.players || []).map((p, i) => ({ ...p, id: p.id ?? i + 1 }));
    nextPlayerId = state.players.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    state.assign = s.assign || {};
    state.autoPrice = s.autoPrice !== false;
    state.sortBuy = s.sortBuy || state.sortBuy;
    state.sortForge = s.sortForge || state.sortForge;
    state.zoom = s.zoom || 1;
    state.cole = !!s.cole;
    state.sell = s.sell || {};
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
  state.players.push({ id: nextPlayerId++, name: "Coop " + state.players.length, qf: 0, slots: 5 });
  renderCrew(); renderQueue(); renderPlan(); renderStats(); save();
});
$("cole").addEventListener("change", e => { state.cole = e.target.checked; renderQueue(); renderPlan(); renderStats(); save(); });
$("tax").addEventListener("input", e => { state.tax = parseFloat(e.target.value) || 0; renderStats(); save(); });

(async function start() {
  try {
    const res = await fetch("/api/recipes");
    const body = await res.json();
    RECIPES = body.recipes;
    CATEGORIES = body.categories || [];
    BAZAAR = new Set(body.bazaar || []);
    AUCTION = new Set(body.auction || []);
    AUCTION_TAGS = body.auctionTags || {};
  } catch (err) {
    $("tree").innerHTML = '<div class="blank">Couldn\'t load the recipe list from the server. Refresh the page.</div>';
    return;
  }
  load();
  $("cole").checked = state.cole;
  $("tax").value = state.tax;
  $("autoPrice").checked = state.autoPrice;
  renderCrew();
  render();
  await refreshBazaarPrices();
  await refreshAuctionPrices({ force: true });
})();
