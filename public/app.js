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
};
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
function walk(item, qty, path, acc) {
  const r = RECIPES[item];
  if (!r || !state.open.has(path)) {
    acc.buy[item] = (acc.buy[item] || 0) + qty;
    return;
  }
  const runs = Math.ceil(qty / (r.out || 1));
  if (!r.craft) {
    acc.forgeSeconds += runs * forgeTime(item);
    acc.processes += runs;
    acc.used.add(item);
    acc.runsPer[item] = (acc.runsPer[item] || 0) + runs;
  }
  if (r.coins) acc.coins += runs * r.coins;
  for (const [ing, n] of r.ing) walk(ing, runs * n, path + "|" + ing, acc);
}

const blank = () => ({ buy: {}, forgeSeconds: 0, processes: 0, coins: 0, used: new Set(), runsPer: {} });

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
      out.push({ key: p.id + "#" + i, player: p, red, n: i + 1, end: 0, tally: {} });
  }
  return out;
}

function buildPlan() {
  const slots = slotList();
  const rows = queueRows();
  const base = {};
  const jobs = [];
  let truncated = false;

  for (const r of rows) {
    base[r.item] = r.each;
    for (let i = 0; i < r.runs; i++) {
      if (jobs.length >= MAX_JOBS) { truncated = true; break; }
      jobs.push({ item: r.item, base: r.each, owner: r.owner ? r.owner.id : null });
    }
    if (truncated) break;
  }

  if (!slots.length || !jobs.length)
    return { slots, makespan: jobs.length ? Infinity : 0, truncated, unplaceable: [] };

  jobs.sort((a, b) => b.base - a.base);

  const unplaceable = new Set();
  for (const job of jobs) {
    const pool = job.owner == null ? slots : slots.filter(s => s.player.id === job.owner);
    if (!pool.length) { unplaceable.add(job.item); continue; }
    let best = null, bestEnd = Infinity;
    for (const s of pool) {
      const finish = s.end + job.base * (1 - s.red);
      /* tie-break onto the faster slot, it'll help later jobs */
      if (finish < bestEnd - 1e-9 || (Math.abs(finish - bestEnd) < 1e-9 && best && s.red > best.red)) {
        best = s; bestEnd = finish;
      }
    }
    best.end = bestEnd;
    best.tally[job.item] = (best.tally[job.item] || 0) + 1;
  }

  /* Shave the bottleneck: try moving one run off the busiest slot somewhere
     it would land sooner. Repeat while it keeps helping. */
  for (let pass = 0; pass < 400; pass++) {
    let hot = slots[0];
    for (const s of slots) if (s.end > hot.end) hot = s;
    const makespan = hot.end;
    let moved = false;

    for (const item of Object.keys(hot.tally)) {
      const owner = state.assign[item];
      if (owner != null && owner !== hot.player.id) continue;
      const b = base[item];
      const without = hot.end - b * (1 - hot.red);
      for (const s of slots) {
        if (s === hot) continue;
        if (owner != null && s.player.id !== owner) continue;
        const landed = s.end + b * (1 - s.red);
        if (landed < makespan - 1e-9 && without < makespan - 1e-9) {
          hot.end = without;
          if (--hot.tally[item] === 0) delete hot.tally[item];
          s.end = landed;
          s.tally[item] = (s.tally[item] || 0) + 1;
          moved = true;
          break;
        }
      }
      if (moved) break;
    }
    if (!moved) break;
  }

  const makespan = slots.reduce((m, s) => Math.max(m, s.end), 0);
  return { slots, makespan, truncated, unplaceable: [...unplaceable], base };
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

function renderPlan() {
  const host = $("plan");
  host.innerHTML = "";
  const plan = buildPlan();

  if (!plan.slots.length) {
    host.innerHTML = '<div class="card"><div class="blank">Nobody has any slots. Add a player in step 4.</div></div>';
    return;
  }
  if (!isFinite(plan.makespan) || plan.makespan === 0) {
    host.innerHTML = '<div class="card"><div class="blank">Nothing to forge yet — open a row in step 2.</div></div>';
    return;
  }

  const hottest = plan.slots.reduce((m, s2) => (s2.end > m.end ? s2 : m), plan.slots[0]);

  const bar = document.createElement("div");
  bar.className = "plan-bar";
  bar.innerHTML =
    `<div><span class="k">Finishes in</span><span class="v ember">${dur(plan.makespan)}</span></div>` +
    `<div><span class="k">That's</span><span class="v">${(plan.makespan / 86400).toFixed(2)} days</span></div>` +
    `<div><span class="k">Slots working</span><span class="v">${plan.slots.filter(s2 => s2.end > 0).length} of ${plan.slots.length}</span></div>` +
    `<div><span class="k">Held up by</span><span class="v">${hottest.player.name || "someone"}, slot ${hottest.n}</span></div>`;
  host.appendChild(bar);

  if (plan.unplaceable.length) {
    const warn = document.createElement("p");
    warn.className = "warn";
    warn.textContent = `Assigned to someone with no slots: ${plan.unplaceable.join(", ")}. Give them slots in step 4 or set those back to Anyone.`;
    host.appendChild(warn);
  }
  if (plan.truncated) {
    const warn = document.createElement("p");
    warn.className = "warn";
    warn.textContent = "That's more than 20,000 forge runs — the plan below covers the longest ones only.";
    host.appendChild(warn);
  }

  for (const p2 of state.players) {
    const mine = plan.slots.filter(s2 => s2.player.id === p2.id);
    if (!mine.length) continue;

    const card = document.createElement("div");
    card.className = "card plan-card";

    const head = document.createElement("div");
    head.className = "plan-head";
    const cut = Math.round(reduction(p2.qf || 0) * 100);
    head.innerHTML =
      `<h3 class="card-title">${p2.name || "unnamed"}</h3>` +
      `<span class="chip">${p2.qf ? "Quick Forge " + p2.qf : "no Quick Forge"}</span>` +
      (state.cole ? '<span class="chip cole">Cole +25%</span>' : "") +
      `<span class="chip cut">${cut}% faster</span>` +
      `<span class="chip">${mine.length} slot${mine.length === 1 ? "" : "s"}</span>`;
    card.appendChild(head);

    for (const slot of mine) {
      const row = document.createElement("div");
      row.className = "slot" + (slot === hottest ? " hot" : "");

      const tag = document.createElement("div");
      tag.className = "slot-n";
      tag.textContent = "Slot " + slot.n;
      row.appendChild(tag);

      const items = document.createElement("div");
      items.className = "slot-items";
      const entries = Object.entries(slot.tally)
        .sort((a, b) => (plan.base[b[0]] * b[1]) - (plan.base[a[0]] * a[1]));
      if (!entries.length) {
        const idle = document.createElement("span");
        idle.className = "idle";
        idle.textContent = "nothing — spare capacity";
        items.appendChild(idle);
      } else {
        for (const [item, count] of entries) {
          const chip = document.createElement("span");
          chip.className = "job";
          chip.innerHTML = `${item}<b>\u00d7${count}</b>`;
          chip.title = `${count} run${count === 1 ? "" : "s"} at ${dur(plan.base[item] * (1 - slot.red))} each here`;
          items.appendChild(chip);
        }
      }
      row.appendChild(items);

      const time = document.createElement("div");
      time.className = "slot-time";
      time.textContent = slot.end ? dur(slot.end) : "—";
      row.appendChild(time);

      const track = document.createElement("div");
      track.className = "slot-bar";
      const fill = document.createElement("i");
      fill.style.width = (plan.makespan ? (slot.end / plan.makespan) * 100 : 0) + "%";
      track.appendChild(fill);
      row.appendChild(track);

      card.appendChild(row);
    }
    host.appendChild(card);
  }

  const note = document.createElement("p");
  note.className = "card-sub";
  note.style.marginTop = "10px";
  note.textContent = "Runs are placed longest-first into whichever slot frees up soonest, then swapped around to shorten the busiest one. It assumes you have the materials ready, so treat it as the best case.";
  host.appendChild(note);
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
  sortBuy: state.sortBuy, sortForge: state.sortForge,
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
