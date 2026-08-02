/* ---------------------------------------------------------------------------
   Back end.

     GET /api/recipes                    the forge data the page renders from
     GET /api/prices?mode=buy            Bazaar prices, keyed by item name
     GET /api/auction?items=A,B,C        lowest-BIN prices for auction-only items
     GET /api/health                     for Render's health check

   Both market calls happen here rather than in the browser, so the page never
   reaches a third-party domain and nothing gets blocked.

   Bazaar comes from Hypixel in one request, cached a minute.
   Auction prices come from Coflnet, one request per item, so they are fetched
   one at a time with a gap between them and cached for ten minutes. Coflnet
   allows 30 requests per 10 seconds and 100 per minute; this stays well under.

   No dependencies. Node 18 or newer.
--------------------------------------------------------------------------- */
const http = require("node:http");
const fs   = require("node:fs");
const path = require("node:path");
const { RECIPES, BAZAAR_IDS, AUCTION_IDS, CATEGORY_ORDER } = require("./data/recipes");

const PORT   = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const BAZAAR_URL   = "https://api.hypixel.net/v2/skyblock/bazaar";
const COFL_BIN     = tag => `https://sky.coflnet.com/api/auctions/tag/${tag}/active/bin`;
const BAZAAR_TTL   = 60_000;
const AUCTION_TTL  = 600_000;
const AUCTION_GAP  = 900;      // ms between Coflnet calls
const AGENT        = "forge-planner";

/* ------------------------------------------------------------------ bazaar */
let bazaarCache = { at: 0, products: null };

async function bazaarProducts() {
  if (bazaarCache.products && Date.now() - bazaarCache.at < BAZAAR_TTL) return bazaarCache.products;
  const res = await fetch(BAZAAR_URL, { headers: { "user-agent": AGENT } });
  if (!res.ok) throw new Error(`Hypixel replied ${res.status}`);
  const body = await res.json();
  if (!body || !body.products) throw new Error("Hypixel sent no product list");
  bazaarCache = { at: Date.now(), products: body.products };
  return bazaarCache.products;
}

/* buy  = insta-buy, what you pay to get it now
   sell = buy-order, cheaper but you wait for a fill */
function bazaarPrices(products, mode) {
  const prices = {}, missing = [];
  for (const [item, id] of Object.entries(BAZAAR_IDS)) {
    const q = products[id] && products[id].quick_status;
    const v = q ? (mode === "sell" ? q.sellPrice : q.buyPrice) : 0;
    if (v > 0) prices[item] = Math.round(v * 100) / 100;
    else missing.push(item);
  }
  return { prices, missing };
}

/* ----------------------------------------------------------------- auction */
const auctionCache = new Map();          // item -> {at, price}
let auctionChain = Promise.resolve();    // keeps Coflnet calls single-file

const fresh = entry => entry && Date.now() - entry.at < AUCTION_TTL;
const wait  = ms => new Promise(r => setTimeout(r, ms));

async function lowestBin(item) {
  const tag = AUCTION_IDS[item];
  if (!tag) return null;
  const hit = auctionCache.get(item);
  if (fresh(hit)) return hit.price;

  const res = await fetch(COFL_BIN(tag), { headers: { "user-agent": AGENT } });
  if (res.status === 429) throw Object.assign(new Error("Coflnet is rate limiting"), { retry: true });
  if (!res.ok) throw new Error(`Coflnet replied ${res.status}`);
  const list = await res.json();

  /* Auctions can hold stacks, so divide by the count to get a unit price. */
  let best = null;
  for (const a of Array.isArray(list) ? list : []) {
    const count = a.count > 0 ? a.count : 1;
    const each = (a.startingBid || 0) / count;
    if (each > 0 && (best === null || each < best)) best = each;
  }
  const price = best === null ? null : Math.round(best);
  auctionCache.set(item, { at: Date.now(), price });
  return price;
}

/* Queue the lookups so only one Coflnet request is in flight at a time. */
function queueLowestBin(item) {
  const run = auctionChain.then(async () => {
    const cached = auctionCache.get(item);
    if (fresh(cached)) return cached.price;
    const price = await lowestBin(item);
    await wait(AUCTION_GAP);
    return price;
  });
  auctionChain = run.catch(() => {});
  return run;
}

async function auctionPrices(items) {
  const prices = {}, failed = [];
  const results = await Promise.allSettled(items.map(queueLowestBin));
  results.forEach((r, i) => {
    const item = items[i];
    if (r.status === "fulfilled" && r.value != null) prices[item] = r.value;
    else failed.push(item);
  });
  return { prices, failed };
}

/* ------------------------------------------------------------------ static */
const TYPES = {
  ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8",
  ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml", ".ico":"image/x-icon",
};

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function serveStatic(res, urlPath) {
  const rel  = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ routes */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/recipes") {
    return json(res, 200, {
      recipes: RECIPES,
      categories: CATEGORY_ORDER,
      bazaar: Object.keys(BAZAAR_IDS),
      auction: Object.keys(AUCTION_IDS),
      auctionTags: AUCTION_IDS,
    });
  }

  if (url.pathname === "/api/prices") {
    const mode = url.searchParams.get("mode") === "sell" ? "sell" : "buy";
    try {
      const { prices, missing } = bazaarPrices(await bazaarProducts(), mode);
      return json(res, 200, { ok: true, mode, prices, missing, fetchedAt: bazaarCache.at });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message });
    }
  }

  if (url.pathname === "/api/auction") {
    const wanted = (url.searchParams.get("items") || "")
      .split(",").map(s => s.trim()).filter(s => s && AUCTION_IDS[s]);
    if (!wanted.length) return json(res, 200, { ok: true, prices: {}, failed: [] });
    try {
      const { prices, failed } = await auctionPrices(wanted.slice(0, 40));
      return json(res, 200, { ok: true, prices, failed, fetchedAt: Date.now() });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message });
    }
  }

  if (url.pathname === "/api/health") return json(res, 200, { ok: true });

  serveStatic(res, url.pathname);
});

server.listen(PORT, () => console.log(`Forge Planner running on http://localhost:${PORT}`));
