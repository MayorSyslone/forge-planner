# Forge Planner

Works out what a Hypixel SkyBlock forge build costs, and how long your coop's
forge slots will be tied up making it.

## Why there's a server

The browser can't call Hypixel's Bazaar API directly from a page like this —
that's what kept failing before. The Node server calls it instead and hands the
prices back to the page from the same origin, so nothing is blocked.

## Structure

```
server.js          back end — serves the page, /api/recipes, /api/prices
data/recipes.js    every forge recipe, duration and Bazaar id (one source of truth)
public/index.html  page structure
public/styles.css  styling
public/app.js      front end — the tree, the maths, the panels
render.yaml        Render blueprint
```

`data/recipes.js` is the only file you'd edit to change game data. The server
sends it to the browser at load, so a change there shows up everywhere.

## Endpoints

| Route | What it does |
|---|---|
| `GET /api/recipes` | Recipes, categories, and which items the Bazaar sells |
| `GET /api/prices?mode=buy` | Bazaar prices keyed by item name. `mode=sell` gives buy-order prices instead |
| `GET /api/health` | Returns `{"ok":true}` — Render pings this |

Bazaar responses are cached for a minute so refreshing doesn't hammer Hypixel.

## Running it locally

Needs Node 18 or newer. No packages to install.

```bash
npm start
```

Then open <http://localhost:3000>.

## Putting it on Render

1. Push this folder to a GitHub repo.
2. On Render, choose **New → Web Service** and point it at the repo.
3. Render reads `render.yaml`, so the settings fill themselves in. If you'd
   rather set them by hand: runtime **Node**, build `npm install`, start
   `npm start`, health check path `/api/health`.
4. Deploy. You'll get a URL you can open on any device — no local file to
   download, nothing to crash.

The free plan sleeps after inactivity, so the first load after a quiet spell
takes a few seconds to wake up.

## Using it

Six steps down the page, in order.

Step 2 is the important one. Every row has an arrow. **Closed** means you're
buying that item at the price in its box. **Open** means you're forging it, so
you pay for its ingredients instead and its forge time joins the queue. Open
Refined Diamond and you'll be forging diamonds; leave it shut and you just buy
them. Rows go as deep as you want — all the way down to raw Mithril if you like.

Step 4 handles a coop properly. Give each person their own Quick Forge level and
slot count; the finish time accounts for the fact that a maxed player's slots
clear work faster than an unperked player's.

## About the data

Forge recipes and durations were checked against the Hypixel wiki, with the
verified ones marked in `data/recipes.js`. Fully expanding a Titanium Drill
DR-X655 reproduces the wiki's raw-material totals exactly — 3,404,800 Mithril,
3,430,400 Diamond, 716,800 Iron Ingot, and so on.

If Hypixel changes a duration, the Forge times panel in step 4 lets you correct
it in the browser straight away. For a permanent fix, edit the `time` field in
`data/recipes.js`.
