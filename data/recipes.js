/* ---------------------------------------------------------------------------
   Forge data. One source of truth — the server serves this to the browser.

   time  : base forge seconds. 0 means it's a normal craft (no forge slot).
   ing   : [[item, qty], ...]
   coins : extra coins paid into the forge on top of materials
   cat   : which group it shows up under when you search

   Every duration marked "checked" came off the Hypixel wiki. The rest are
   best-known values — the app lets you correct any of them without editing
   this file, but if you want a permanent fix, change it here.
--------------------------------------------------------------------------- */
const H = 3600;

const RECIPES = {
  /* ---- refining ---- */
  "Refined Diamond":  {cat:"Refining", time:8*H,  ing:[["Enchanted Diamond Block",2]]},
  "Refined Mithril":  {cat:"Refining", time:6*H,  ing:[["Enchanted Mithril",160]]},          // checked
  "Refined Titanium": {cat:"Refining", time:12*H, ing:[["Enchanted Titanium",16]]},          // checked

  /* ---- components ---- */
  "Fuel Canister":    {cat:"Components", time:10*H, ing:[["Enchanted Coal Block",2]]},
  "Golden Plate":     {cat:"Components", time:6*H,  ing:[["Enchanted Gold Block",2],["Glacite Jewel",5],["Refined Diamond",1]]},   // checked
  "Mithril Plate":    {cat:"Components", time:18*H, ing:[["Refined Mithril",5],["Golden Plate",1],["Enchanted Iron Block",1],["Refined Titanium",1]]}, // checked
  "Drill Motor":      {cat:"Components", time:30*H, ing:[["Treasurite",10],["Enchanted Iron Block",1],["Enchanted Redstone Block",3],["Golden Plate",1]]}, // checked
  "Gemstone Mixture": {cat:"Components", time:4*H,  ing:[["Fine Jade Gemstone",4],["Fine Amber Gemstone",4],["Fine Amethyst Gemstone",4],["Fine Sapphire Gemstone",4],["Sludge Juice",320]]}, // checked
  "Gemstone Chamber": {cat:"Components", time:4*H,  coins:25000, ing:[["Worm Membrane",100],["Gemstone Mixture",1]]}, // checked
  "Pure Mithril":     {cat:"Components", time:6*H,  ing:[["Refined Mithril",2]]},            // checked

  /* ---- drills ---- */
  "Mithril Drill SX-R226":  {cat:"Drills", time:4*H, ing:[["Refined Mithril",3],["Fuel Canister",1],["Drill Motor",1]]},          // checked
  "Mithril Drill SX-R326":  {cat:"Drills", time:30,  ing:[["Mithril Drill SX-R226",1],["Golden Plate",1],["Mithril Plate",1]]},   // checked
  "Titanium Drill DR-X355": {cat:"Drills", time:4*H, ing:[["Refined Titanium",8],["Refined Mithril",8],["Drill Motor",1],["Fuel Canister",1],["Golden Plate",6]]}, // checked
  "Titanium Drill DR-X455": {cat:"Drills", time:30,  ing:[["Titanium Drill DR-X355",1],["Refined Diamond",10],["Refined Titanium",12],["Mithril Plate",5]]}, // checked
  "Titanium Drill DR-X555": {cat:"Drills", time:30,  ing:[["Titanium Drill DR-X455",1],["Refined Diamond",20],["Refined Titanium",16],["Enchanted Iron Block",2],["Mithril Plate",10],["Plasma",20]]}, // checked
  "Titanium Drill DR-X655": {cat:"Drills", time:30,  ing:[["Titanium Drill DR-X555",1],["Corleonite",30],["Flawless Ruby Gemstone",1],["Refined Diamond",5],["Gemstone Mixture",16],["Refined Titanium",32],["Mithril Plate",10]]}, // checked
  "Divan's Drill":          {cat:"Drills", time:30,  coins:50000000, ing:[["Titanium Drill DR-X655",1],["Divan's Alloy",1]]}, // checked

  /* ---- fuel tanks ---- */
  "Mithril-Infused Fuel Tank":  {cat:"Fuel tanks", time:10*H, ing:[["Refined Diamond",5],["Refined Mithril",10],["Fuel Canister",5]]},
  "Titanium-Infused Fuel Tank": {cat:"Fuel tanks", time:30,   ing:[["Mithril-Infused Fuel Tank",1],["Refined Titanium",10],["Refined Diamond",5],["Fuel Canister",5]]}, // checked
  "Gemstone Fuel Tank":         {cat:"Fuel tanks", time:30,   ing:[["Titanium-Infused Fuel Tank",1],["Precursor Apparatus",4],["Gemstone Mixture",10]]}, // checked
  "Perfectly-Cut Fuel Tank":    {cat:"Fuel tanks", time:30,   ing:[["Gemstone Fuel Tank",1],["Precursor Apparatus",16],["Gemstone Mixture",25],["Plasma",32]]}, // checked

  /* ---- drill engines ---- */
  "Mithril-Plated Drill Engine":   {cat:"Engines", time:24*H, ing:[["Drill Motor",2],["Mithril Plate",1]]},  // checked
  "Titanium-Plated Drill Engine":  {cat:"Engines", time:30,   ing:[["Mithril-Plated Drill Engine",1],["Refined Titanium",8],["Drill Motor",2]]}, // checked
  "Ruby-Polished Drill Engine":    {cat:"Engines", time:30,   ing:[["Titanium-Plated Drill Engine",1],["Perfect Ruby Gemstone",1],["Drill Motor",5],["Precursor Apparatus",4]]}, // checked
  "Sapphire-Polished Drill Engine":{cat:"Engines", time:30,   ing:[["Ruby-Polished Drill Engine",1],["Perfect Sapphire Gemstone",3],["Precursor Apparatus",8],["Drill Motor",5],["Plasma",16]]}, // checked
  "Amber-Polished Drill Engine":   {cat:"Engines", time:30,   ing:[["Sapphire-Polished Drill Engine",1],["Perfect Amber Gemstone",5],["Precursor Apparatus",16],["Drill Motor",5],["Plasma",32]]}, // checked
};

/* Crafts cost no forge slot and no time. Opening one just walks further down
   toward raw materials, the same way the wiki's recipe tree does. */
const CRAFTS = {
  "Enchanted Diamond Block":[["Enchanted Diamond",160]],
  "Enchanted Diamond":[["Diamond",160]],
  "Enchanted Gold Block":[["Enchanted Gold",160]],
  "Enchanted Gold":[["Gold Ingot",160]],
  "Enchanted Iron Block":[["Enchanted Iron",160]],
  "Enchanted Iron":[["Iron Ingot",160]],
  "Enchanted Coal Block":[["Enchanted Coal",160]],
  "Enchanted Coal":[["Coal",160]],
  "Enchanted Redstone Block":[["Enchanted Redstone",160]],
  "Enchanted Redstone":[["Redstone",160]],
  "Enchanted Mithril":[["Mithril",160]],
  "Enchanted Titanium":[["Titanium",160]],
  "Precursor Apparatus":[["Control Switch",1],["Electron Transmitter",1],["FTX 3070",1],
                         ["Robotron Reflector",1],["Superlite Motor",1],["Synthetic Heart",1]],
};

const GEMS = ["Ruby","Amber","Sapphire","Jade","Amethyst","Topaz",
              "Jasper","Opal","Onyx","Aquamarine","Citrine","Peridot"];

/* Every gemstone tier is 80 of the tier below it; Perfect is forged. */
for (const g of GEMS) {
  CRAFTS[`Flawed ${g} Gemstone`]   = [[`Rough ${g} Gemstone`,80]];
  CRAFTS[`Fine ${g} Gemstone`]     = [[`Flawed ${g} Gemstone`,80]];
  CRAFTS[`Flawless ${g} Gemstone`] = [[`Fine ${g} Gemstone`,80]];
  RECIPES[`Perfect ${g} Gemstone`] = {cat:"Gemstones", time:20*H,
    ing:[[`Flawless ${g} Gemstone`,5],[`${g} Crystal`,1]]};
}
for (const [name, ing] of Object.entries(CRAFTS)) RECIPES[name] = {time:0, ing, craft:true};

/* Bazaar product ids, used server-side to turn the Bazaar dump into prices.
   Anything absent here is auction-house only and stays manual. */
const BAZAAR_IDS = {
  "Diamond":"DIAMOND","Enchanted Diamond":"ENCHANTED_DIAMOND","Enchanted Diamond Block":"ENCHANTED_DIAMOND_BLOCK",
  "Gold Ingot":"GOLD_INGOT","Enchanted Gold":"ENCHANTED_GOLD","Enchanted Gold Block":"ENCHANTED_GOLD_BLOCK",
  "Iron Ingot":"IRON_INGOT","Enchanted Iron":"ENCHANTED_IRON","Enchanted Iron Block":"ENCHANTED_IRON_BLOCK",
  "Coal":"COAL","Enchanted Coal":"ENCHANTED_COAL","Enchanted Coal Block":"ENCHANTED_COAL_BLOCK",
  "Redstone":"REDSTONE","Enchanted Redstone":"ENCHANTED_REDSTONE","Enchanted Redstone Block":"ENCHANTED_REDSTONE_BLOCK",
  "Mithril":"MITHRIL_ORE","Enchanted Mithril":"ENCHANTED_MITHRIL","Refined Mithril":"REFINED_MITHRIL",
  "Titanium":"TITANIUM_ORE","Enchanted Titanium":"ENCHANTED_TITANIUM","Refined Titanium":"REFINED_TITANIUM",
  "Refined Diamond":"REFINED_DIAMOND","Pure Mithril":"PURE_MITHRIL",
  "Golden Plate":"GOLDEN_PLATE","Mithril Plate":"MITHRIL_PLATE","Fuel Canister":"FUEL_TANK","Drill Motor":"DRILL_ENGINE",
  "Gemstone Mixture":"GEMSTONE_MIXTURE","Gemstone Chamber":"GEMSTONE_CHAMBER",
  "Treasurite":"TREASURITE","Corleonite":"CORLEONITE","Plasma":"PLASMA","Glacite Jewel":"GLACITE_JEWEL",
  "Sludge Juice":"SLUDGE_JUICE","Worm Membrane":"WORM_MEMBRANE","Precursor Apparatus":"PRECURSOR_APPARATUS",
  "Control Switch":"CONTROL_SWITCH","Electron Transmitter":"ELECTRON_TRANSMITTER","FTX 3070":"FTX_3070",
  "Robotron Reflector":"ROBOTRON_REFLECTOR","Superlite Motor":"SUPERLITE_MOTOR","Synthetic Heart":"SYNTHETIC_HEART",
};
for (const g of GEMS) {
  const key = g.toUpperCase();
  for (const tier of ["Rough","Flawed","Fine","Flawless","Perfect"])
    BAZAAR_IDS[`${tier} ${g} Gemstone`] = `${tier.toUpperCase()}_${key}_GEM`;
}

const CATEGORY_ORDER = ["Drills","Engines","Fuel tanks","Components","Refining","Gemstones"];

/* Auction-house item tags, looked up through Coflnet's lowest-BIN endpoint.
   Anything the Bazaar already covers is not repeated here. A tag that returns
   nothing just leaves that price blank for you to fill in. */
const AUCTION_IDS = {
  "Mithril Drill SX-R226":"MITHRIL_DRILL_1",
  "Mithril Drill SX-R326":"MITHRIL_DRILL_2",
  "Titanium Drill DR-X355":"TITANIUM_DRILL_1",
  "Titanium Drill DR-X455":"TITANIUM_DRILL_2",
  "Titanium Drill DR-X555":"TITANIUM_DRILL_3",
  "Titanium Drill DR-X655":"TITANIUM_DRILL_4",
  "Divan's Drill":"DIVAN_DRILL",
  "Divan's Alloy":"DIVAN_ALLOY",
  "Mithril-Infused Fuel Tank":"MITHRIL_INFUSED_FUEL_TANK",
  "Titanium-Infused Fuel Tank":"TITANIUM_INFUSED_FUEL_TANK",
  "Gemstone Fuel Tank":"GEMSTONE_FUEL_TANK",
  "Perfectly-Cut Fuel Tank":"PERFECTLY_CUT_FUEL_TANK",
  "Mithril-Plated Drill Engine":"MITHRIL_PLATED_DRILL_ENGINE",
  "Titanium-Plated Drill Engine":"TITANIUM_PLATED_DRILL_ENGINE",
  "Ruby-Polished Drill Engine":"RUBY_POLISHED_DRILL_ENGINE",
  "Sapphire-Polished Drill Engine":"SAPPHIRE_POLISHED_DRILL_ENGINE",
  "Amber-Polished Drill Engine":"AMBER_POLISHED_DRILL_ENGINE",
};
for (const g of GEMS) AUCTION_IDS[`${g} Crystal`] = `${g.toUpperCase()}_CRYSTAL`;

module.exports = { RECIPES, BAZAAR_IDS, AUCTION_IDS, CATEGORY_ORDER };
