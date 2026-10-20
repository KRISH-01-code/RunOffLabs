# Demo script (about 3 minutes)

A walkthrough for showing RunoffLab live or recording a video. Before you
start: run the app, open a fresh copy of the sample (**Projects → New from
sample**), dismiss the getting-started strip, and turn your volume up.

## 0:00 – The problem (20 s)

> "When it rains on a parking lot, almost none of the water soaks in. It runs
> into the storm drains, carrying sediment and phosphorus, and in big storms
> it overloads the pipes. Green infrastructure (rain gardens, permeable
> pavement, green roofs) can fix that, but it costs money, and you need to
> know which design is worth it. RunoffLab answers that with EPA SWMM, the
> standard engineering model."

Show the **Site editor** with the Northfield campus: a building, two parking
lots, lawns, three drains and the pipe network.

## 0:20 – Design something (40 s)

1. Press **R** and drag a rain garden into the median strip beside Lot A.
   Point out the sidebar: it automatically captures runoff from the lot, and
   the **checks** run live (loading ratio, budget, overlaps).
2. Press **G** and drag a small green roof on the Science Hall. Press **B** and
   drop a cistern on the plaza: "full after 25 mm of rain on that roof."
3. Undo those two (**⌘Z ⌘Z**) so we're back to the sample design.

> "Every rule is checked before anything runs, so the model never produces
> numbers for a design that couldn't be built."

## 1:00 – Run SWMM (30 s)

Click **Run comparison**. Read the impact line:

> "This design keeps 250 m³ of stormwater on site: 30 % less runoff, 13 %
> lower peak flow."

Scroll to **Water quality**:

> "It removes 44 % of the sediment, but many permits require 80 %. So this
> design isn't good enough yet. That's the kind of thing you want to find out
> before you build."

## 1:30 – Watch the storm in 3D (40 s)

Open **3D view → Storm replay**, turn **Sound on**, press **Play**.

> "This is the actual SWMM time series. The rain intensity, the runoff on each
> surface, the water flowing into the rain garden, and the pipes filling up.
> At the peak you can see pipes C2 and C3 go amber: over 90 % full."

Switch to **Baseline** to show the pipes going red without the design.
Mention **Record video**: the clip in the README was made with it.

## 2:10 – Let the computer search (40 s)

Open **Design Explorer**, click **Explore designs**.

> "It generates layouts from the site geometry and runs every one through
> SWMM in parallel: 200 designs in about five seconds. Green dots are the best
> trade-offs: nothing else is both cheaper and better."

Click a dot near the budget line, then **Add to my designs**. Back in the
results, open **Compare designs → Compare all designs**:

> "Ranked by cost per cubic metre of water kept on site, with sediment
> removal alongside."

## 2:50 – Wrap up (10 s)

> "Draw your own site in Site layout, export a PDF report, and it all runs
> locally with no API keys. Every number comes from SWMM."

## Tips

- If the Explorer's top designs barely differ, switch **Minimise** to
  **Peak flow** for a different story.
- For a shorter clip, record the replay at **1×** with **Auto-orbit** on.
- The heavy-rain lightning and thunder only appear in storms above 25 mm/h,
  which the sample's SCS Type II storm reaches at its peak.
