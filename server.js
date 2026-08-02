/* ---------------------------------------------------------------------------
   Back end.

   Two jobs:
     GET /api/recipes            -> the forge data the page renders from
     GET /api/prices?mode=buy    -> current Bazaar prices, keyed by item name

   The Bazaar call happens here rather than in the browser, so the page never
   has to reach a third-party domain. Results are cached for a minute so a
   page refresh doesn't hammer Hypixel.

   No dependencies. Node 18 or newer (it needs the built-in fetch).
--------------------------------------------------------------------------- */
const http = require("node:http");
const fs   = require("node:fs");
const path = require("node:path");
const { RECIPES, BAZAAR_IDS, CATEGORY_ORDER } = require("./data/recipes");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const BAZAAR_URL = "https://api.hypixel.net/v2/skyblock/bazaar";
const CACHE_MS = 60_000;

let cache = { at: 0, products: null };

async function bazaarProducts() {
  if (cache.products && Date.now() - cache.at < CACHE_MS) return cache.products;
  const res = await fetch(BAZAAR_URL, { headers: { "user-agent": "forge-planner" } });
  if (!res.ok) throw new Error(`Hypixel replied ${res.status}`);
  const body = await res.json();
  if (!body || !body.products) throw new Error("Hypixel sent no product list");
  cache = { at: Date.now(), products: body.products };
  return cache.products;
}

/* buy  = what it costs to insta-buy
   sell = what a buy order fills at, i.e. the cheaper, slower route */
function pricesFrom(products, mode) {
  const prices = {}, missing = [];
  for (const [item, id] of Object.entries(BAZAAR_IDS)) {
    const q = products[id] && products[id].quick_status;
    const v = q ? (mode === "sell" ? q.sellPrice : q.buyPrice) : 0;
    if (v > 0) prices[item] = Math.round(v * 100) / 100;
    else missing.push(item);
  }
  return { prices, missing };
}

const TYPES = {
  ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8",
  ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml", ".ico":"image/x-icon",
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {"content-type":"text/plain"}); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/recipes") {
    return json(res, 200, { recipes: RECIPES, categories: CATEGORY_ORDER, bazaar: Object.keys(BAZAAR_IDS) });
  }

  if (url.pathname === "/api/prices") {
    const mode = url.searchParams.get("mode") === "sell" ? "sell" : "buy";
    try {
      const { prices, missing } = pricesFrom(await bazaarProducts(), mode);
      return json(res, 200, { ok: true, mode, prices, missing, fetchedAt: cache.at });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message });
    }
  }

  if (url.pathname === "/api/health") return json(res, 200, { ok: true });

  serveStatic(res, url.pathname);
});

server.listen(PORT, () => console.log(`Forge Planner running on http://localhost:${PORT}`));
