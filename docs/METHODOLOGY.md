# Methodology & assumptions

RunoffLab is a screening tool. It turns a simple site description into an
EPA SWMM 5.2 model, runs it, and reports what SWMM computes. The assumptions
below are applied the same way to the baseline and to every design. That
makes comparisons between them meaningful, even though absolute values
depend on parameters that should be calibrated for a real site.

## Rainfall
- **Design storms only.** RunoffLab does not include observed rainfall
  records or official return-period depths. The user picks a total depth and
  a temporal pattern:
  - **SCS Type II, 24 h**: cumulative table from USDA-SCS TR-55 (1986),
    linearly interpolated.
  - **Triangular**: Yen & Chow (1980), with an adjustable peak position.
  - **Uniform block.**
- The hyetograph uses 5-minute steps. Its total equals the chosen depth
  exactly, and a test checks this.
- To relate a depth to a return period, use local IDF data (for example,
  NOAA Atlas 14). Larger depths in what-if runs are hypothetical scenarios,
  not climate projections.

## Infiltration (native soil)
- SWMM's Green-Ampt method, using texture-class parameters from
  Rawls, Brakensiek & Miller (1983) as tabulated in the SWMM 5 User's Manual.
- The initial moisture deficit is porosity minus field capacity: the soil
  starts at field capacity.
- The *infiltration factor* scales native-soil Ksat and the LID seepage rate
  together. It is a sensitivity knob for compaction or clogging.

## Surfaces
- Roofs and pavement are 100 % impervious. Lawns and planted beds are 0 %.
- Manning's n and depression storage are typical values from the SWMM manual:
  - impervious: n 0.011–0.012, 1.5 mm storage;
  - lawn: n 0.15, 5 mm storage;
  - SWMM's default 25 % of impervious area has no depression storage.
- Sheet-flow width = area ÷ the rectangle's shorter side.

## Green infrastructure
- **Rain garden (SWMM `RG`).**
  - The user sets ponding depth, soil depth and gravel depth.
  - Engineered soil is modelled as loamy sand: porosity 0.437, field capacity
    0.105, wilting point 0.047, Ksat 30 mm/h, suction 61.3 mm.
  - Vegetation occupies 10 % of the ponding volume. Gravel void ratio is 0.75.
  - Water seeps into native soil at that soil's Ksat. There is no underdrain.
  - The garden captures a user-set area of one adjacent impervious surface.
    It is modelled in that surface's subcatchment via SWMM's
    "% impervious area treated", and its footprint area is moved there from
    the lawn so total site area is conserved.
- **Permeable pavement (SWMM `PP`).**
  - The user sets pavement thickness and storage depth.
  - Pavement void ratio is 0.15 and permeability 1000 mm/h, which is
    conservative compared with new pavement. Stone void ratio is 0.75.
  - Seepage happens at native Ksat. There is no underdrain and no clogging.
  - Optional run-on from the rest of the host surface.
- **Green roof (SWMM `GR`).** Built on a roof; receives only the rain on it.
  - The user sets growing-medium depth (50–300 mm) and drainage-mat
    thickness.
  - Growing medium: porosity 0.5, field capacity 0.25, wilting point 0.1,
    Ksat 100 mm/h, suction 50 mm. Vegetation occupies 10 % of the surface.
    Drainage mat void fraction 0.5, roughness 0.1. No surface berm.
  - Like permeable pavement, it is an LID unit inside the roof's
    subcatchment, so the roof has less area left to send to other features.
- **Infiltration trench (SWMM `IT`).** Built in a lawn or planted bed;
  captures runoff from an adjacent impervious surface, modelled exactly like a
  rain garden's capture.
  - The user sets the stone depth (300–3000 mm). Stone void ratio 0.75; a
    25 mm surface depression on top. Seeps at native Ksat; no underdrain.
  - The same loading limit as rain gardens applies.
- **Rain barrel / cistern (SWMM `RB`).** Stands on a sidewalk, lawn or bed
  beside a building; collects from part of that roof (only roofs may feed it).
  - The user sets the tank height and how many hours after the rain stops
    its drain opens. The drain follows q = C·h^0.5, with C chosen so a full
    tank empties in about 24 h. It overflows when full.
  - Cost is per m³ of tank (footprint × height); the others are per m².
  - A full barrel keeps exactly its own volume out of the pipes; the backend
    tests check this.
- **LIDs start empty**, at 0 % initial saturation.
- **Constraints** (all user-editable):
  - contributing area ≤ 15 × the footprint, for rain gardens and trenches;
  - pavement run-on ≤ 2 × its own area;
  - a contributing surface must be within 5 m of the garden's host surface.
- **Unit costs** (USD 250/m² for rain gardens, 150/m² for permeable
  pavement, 180/m² for green roofs, 200/m² for infiltration trenches and
  700/m³ of tank for rain barrels) are illustrative placeholders, not sourced
  quotes. Replace them with local figures.

## Water quality
- **Pollutants.** Total suspended solids (TSS, sediment) and total
  phosphorus (TP), each a SWMM pollutant in mg/L.
- **Washoff.** Each surface type is a SWMM land use whose runoff carries a
  fixed event mean concentration (EMC), so a surface's load is its runoff
  volume × its EMC (a test checks this against SWMM). TSS / TP, mg/L: roof
  20 / 0.10, parking 85 / 0.25, road 100 / 0.25, sidewalk 50 / 0.20, lawn
  50 / 0.35, planted bed 40 / 0.30. These are typical urban values of the order
  reported by the National Stormwater Quality Database (Pitt, Maestre &
  Morquecho 2004); they are illustrative, not site measurements.
- **Removal by green infrastructure** is computed by SWMM:
  - water a feature soaks into the ground, evaporates or still holds at the end
    takes its pollutants with it;
  - water leaving through an underdrain is treated (SWMM LID `REMOVALS`):
    permeable pavement 80 % TSS / 40 % TP, infiltration trench 80 / 50, rain
    barrel 30 / 10 (settling). Rain gardens and green roofs have no underdrain.
- **Reported** as the mass leaving at the outfall over the run (kg) and the %
  removed versus the baseline, against an 80 % TSS-removal target that many
  stormwater permits use.
- **Not modelled:** buildup between storms (each storm washes off at the
  same concentration, even in year-long runs), first flush, street sweeping,
  dissolved vs particulate phosphorus, or pollutants lost with flooding.

## Year-long (continuous) simulation
- **Question answered:** what share of all the rain in a year the site keeps
  out of the pipes, rather than how it copes with one design storm.
- **Rainfall:** hourly depths for a year (or any record up to two years),
  either
  - **imported** from a CSV of time and rainfall (mm or inches per reading,
    or mm/h or in/h intensity). Readings are summed into hours and missing
    hours count as dry; or
  - **synthetic:** a Poisson rectangular-pulse model (cf. Rodriguez-Iturbe,
    Cox & Isham 1987). Storms arrive on average every ~3 days (about 40 %
    more often in the wetter half of the year), last ~6 h on average, and rain
    at a random intensity that varies hour to hour. The year is scaled to the
    chosen annual total, and "Try another year" changes the random seed. It is
    plausible weather, not a measured record.
- **Model:** the same site, design, soils and LID controls as the design
  storm, run continuously, with constant potential evaporation of 3 mm/day so
  soils and LIDs dry out between storms. Hourly reporting, a 5 min wet /
  1 h dry runoff step and a 30 s routing step keep a year to about 1.5 s. The
  run continues 48 h after the record ends.
- **Reported:**
  - rain kept on site = 1 − runoff ÷ rainfall;
  - runoff, sediment and phosphorus over the period;
  - days on which more than 1 m³ left the site;
  - runoff by month. SWMM's exact total is split between months in
    proportion to the hourly flows it reports.

## Drainage and simulation
- Dynamic-wave routing with a 5 s routing step (variable step 0.75).
- Inlets are SWMM junctions. Water that overflows a rim is counted as
  flooding and leaves the system (no surface ponding).
- Simulations run for the storm duration plus a 12 h drain period (editable).
  Water still held in LIDs at the end is reported as storage, not as runoff.
- Every result records:
  - SWMM runoff continuity error;
  - SWMM routing continuity error;
  - the SWMM and PySWMM versions;
  - the SHA-256 of the input file.

## Design Explorer (optimizer)
- **Search space.** Candidate spots are derived from the site geometry:
  - a rain-garden strip inside each lawn or planted bed, along each edge that
    faces a paved surface within the capture distance (up to 6 m deep, or
    half the lawn's depth);
  - a band of permeable pavement inside each parking lot or plaza (up to
    20 m wide);
  - optionally, a green roof on each roof, 1.5 m clear of its edges.
  Trenches and rain barrels aren't searched; add them by hand.
  Each spot is either empty or built at one of four sizes (25–100 % of its
  length), 2 m clear of the surface ends.
- **Routing.** A rain garden captures up to 10× its own area (or the project's
  loading limit, if lower) from the surface it faces. Pavement takes run-on of
  up to 1× its area (or the project's limit). Neither may take more than the
  surface has left after paving and other capture.
- **Search.** Every single-spot design at every size is tried first, then
  random layouts, then mutations and crossovers of the current best
  trade-offs. Candidates that fail any constraint check (budget, area,
  overlap, loading) are discarded before SWMM runs. The Pareto front is the
  set of designs that no other design beats on both cost and the chosen
  metric (runoff volume or peak outfall discharge).
- This is a heuristic search: it finds good trade-offs within the generated
  spots, not a proven global optimum, and it does not invent shapes the spot
  generator doesn't propose.

## What-if analysis
Seven cases, each run for the baseline and the design: the design storm;
0.5×, 1.5× and 2× its depth; infiltration ×0.5 and ×0.25 (native soil and
LID seepage, standing in for compaction and clogging); and 1.5× depth with
infiltration ×0.5. The infiltration factor scales the native-soil saturated
conductivity and LID seepage rates, as in the scenario settings.

## Limitations
- The sample site is fictional: its geometry and elevations are illustrative.
- There is no calibration against observed flows. Results are for comparing
  options, not for design sign-off.
- Rectangular geometry. One soil type per site. No groundwater, water quality
  or long-term (continuous) simulation yet.

## References
- Rossman, L.A. (2015). *Storm Water Management Model User's Manual, Version 5.1.*
  EPA/600/R-14/413b.
- Rawls, W.J., Brakensiek, D.L. & Miller, N. (1983). Green-Ampt infiltration
  parameters from soils data. *J. Hydraulic Eng.* 109(1), 62–70.
- USDA-SCS (1986). *Urban Hydrology for Small Watersheds*, TR-55.
- Yen, B.C. & Chow, V.T. (1980). Design hyetographs for small drainage
  structures. *J. Hydraulics Div.* 106(6), 1055–1076.
- McDonnell, B. et al. (2020). PySWMM: The Python Interface to SWMM.
  *JOSS* 5(52), 2292.
