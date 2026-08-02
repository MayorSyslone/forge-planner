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
| `GET /api/recipes` | Recipes, categories, and which items come from the Bazaar or the auction house |
| `GET /api/prices?mode=buy` | Bazaar prices keyed by item name. `mode=sell` gives buy-order prices instead |
| `GET /api/auction?items=A,B` | Lowest-BIN prices for auction-only items, via Coflnet |
| `GET /api/health` | Returns `{"ok":true}` — Render pings this |

Bazaar is one request to Hypixel, cached for a minute. Auction prices cost one
Coflnet request per item, so they run one at a time with a gap between them and
are cached for ten minutes — comfortably inside Coflnet's 30-per-10-seconds and
100-per-minute limits. Only items actually on your shopping list get looked up.

Auction price data comes from [SkyCofl](https://sky.coflnet.com/data), who ask
to be credited — that's the link in the page footer. Leave it there.

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

Step 2 is the important one. Every row has an arrow, and a row is in one of
three states:

- **Bought** (plain text) — you pay the price in its box.
- **Forged** (orange) — takes a forge slot and real time.
- **Crafted** (blue) — a normal crafting recipe. Instant, no slot, no waiting.
  Enchanted blocks and the gemstone tiers are all crafts.

Open Refined Diamond and you'll be forging diamonds; leave it shut and you just
buy them. Rows go as deep as you want — all the way down to raw Mithril.

Step 4 handles a coop properly. Give each person their own Quick Forge level and
slot count; the finish time accounts for the fact that a maxed player's slots
clear work faster than an unperked player's.

Step 7 is the forging plan. A forge run occupies one slot for its whole
duration — it can't be split — so working out the finish time is a scheduling
problem, not a division. Every run is laid into a specific slot, longest first,
each going wherever it would finish soonest, followed by a swap pass that
shaves the busiest slot. The build is done when the last slot is done, and the
plan shows exactly what each person should put in each of their slots.

Both charts scroll sideways and zoom from 1x (whole build on screen) up to 64x.
Item names and slot labels stay pinned while the bars slide. Pointing anywhere
on the slot chart reads out that moment: which slots are mid-forge and how long
they have left, and what has finished and is sitting in your inventory. Click
to pin the readout, click again to release.

That also means a single 30-second forge takes 30 seconds no matter how many
slots you have, which the earlier version got wrong.

The plan respects dependencies: a Mithril Plate can't start until its Refined
Mithril is out of the forge, and the drill can't start until every part is
done. Runs of the same item still go in parallel, and the scheduler reuses
idle gaps, so a gap in one slot means it's genuinely waiting on something.

Step 6 has two live lists, both sortable by any column. **Buy** is everything
you aren't forging. **Forge** is every run the forge has to do, with a "Forged
by" column — assign a job to one person and it queues on their slots alone, at
their Quick Forge rate. Anything left on "Anyone" spreads across the crew, and
the finish time is worked out so nobody sits idle while someone else is buried.

## About the data

Forge recipes and durations were checked against the Hypixel wiki, with the
verified ones marked in `data/recipes.js`. Fully expanding a Titanium Drill
DR-X655 reproduces the wiki's raw-material totals exactly — 3,404,800 Mithril,
3,430,400 Diamond, 716,800 Iron Ingot, and so on.

If Hypixel changes a duration, the Forge times panel in step 4 lets you correct
it in the browser straight away. For a permanent fix, edit the `time` field in
`data/recipes.js`.
