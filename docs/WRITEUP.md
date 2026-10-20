# RunoffLab: a stormwater design tool built on EPA SWMM

*Project write-up. Adapt the wording to your own voice before publishing.*

## The problem

Paved sites send almost all of their rain straight into storm drains. That
water carries sediment, oil and nutrients into creeks, and in heavy storms it
overloads pipes and floods streets. Green infrastructure (rain gardens,
permeable pavement, green roofs, infiltration trenches, cisterns) lets water
soak in or slows it down, but every square metre costs money. The practical
question for a site is: **which features, where, and how big, give the most
benefit for the budget?**

Engineers answer this with EPA's Storm Water Management Model (SWMM), which is
accurate but hard to use: designs are written as text input files and results
come back as long reports. RunoffLab puts SWMM behind an interactive tool, so
you draw a design on a plan and see what it does.

## What it does

- **Draw a site and a design.** An SVG editor for roofs, parking, roads,
  sidewalks, lawns, drains and pipes, plus five kinds of green infrastructure.
  Constraint checks run as you edit: footprints must sit on an allowed
  surface, rain gardens can only capture runoff from paving within 5 m, loading
  ratios, budget, available area, and a pipe network that drains to the outfall.
- **Simulate with SWMM.** Each design becomes a SWMM 5.2 model: every surface
  a subcatchment, every feature a native LID control, dynamic-wave pipe
  routing, and Green-Ampt infiltration from the soil type.
- **See the results.** Runoff volume, peak flow, the site's water balance,
  each feature's performance, drain flooding, and water quality (sediment and
  phosphorus leaving the site, against the 80 % TSS-removal target many
  permits use).
- **Search for good designs.** The Design Explorer generates candidate spots
  from the site geometry and searches hundreds of layouts in parallel SWMM
  runs, keeping the Pareto front of cost against runoff or peak flow.
- **Look at a whole year.** A continuous SWMM run through a year of hourly
  rain (synthetic, or a measured record imported from CSV) reports the share
  of the year's rain kept on site, yearly runoff and sediment, and runoff by
  month: the annual view regulators often ask for.
- **Stress-test and compare.** What-if runs (smaller and bigger storms,
  clogged soils) and a ranked comparison of every design by cost per cubic
  metre of runoff kept on site.
- **Watch the storm.** A three.js view replays the SWMM time series in 3D:
  rain at the recorded intensity, runoff running to drains and rain gardens,
  pipes filling, and spray at the outfall. It includes synthesised sound and
  one-click video export.
- **Share it.** PDF reports with every assumption and its source, and
  projects saved in SQLite.

## Results on the sample site

A fictional 2.4 ha campus block (a building, two parking lots and lawns) in a
50 mm, 24-hour SCS Type II storm on silt loam:

| | Existing site | With a median rain garden + permeable pavers |
|---|---|---|
| Runoff | 826 m³ | 576 m³ (−30 %) |
| Peak outfall flow | 0.335 m³/s | 0.291 m³/s (−13 %) |
| Soaked into the ground | 357 m³ | 503 m³ (+41 %) |
| Sediment (TSS) to the creek | 54.4 kg | 30.3 kg (−44 %) |
| Rain kept on site over a 1,000 mm year | 45 % | 63 % |
| Cost | | $240,000 of a $250,000 budget |

The Design Explorer, searching 200 layouts in about five seconds, finds
designs within the same budget that cut runoff by roughly half. One finding
worth noting: green roofs never make its list of best trade-offs on this
site. A green roof only holds the rain falling on it, while a rain garden
treats runoff from up to fifteen times its own area, so per dollar the rain
garden wins. The sample design also falls well short of 80 % sediment
removal, which is exactly the kind of gap the tool is meant to expose before
anything is built.

## How it's built

| Layer | Technology |
|---|---|
| Engine | EPA SWMM 5.2.4 through PySWMM 2.2 |
| API | Python, FastAPI, Pydantic models, SQLite with optimistic versioning |
| Optimizer | Pareto search over generated spots, parallel worker processes |
| Reports | ReportLab PDF |
| Web app | Next.js 16, React 19, TypeScript, hand-built SVG charts |
| 3D | three.js with custom GLSL shaders for ripples and pipe flow; Web Audio for sound; MediaRecorder for video |
| Tests | 76 pytest tests, 39 Vitest unit tests, 13 Playwright browser tests |
| Deployment | Docker images and docker-compose |

Some engineering decisions:

- **SWMM is the source of truth.** The app never estimates a result itself.
  The tests check the engine against hand calculations: runoff from an
  impervious roof equals rain minus depression storage, a full cistern keeps
  exactly its own volume out of the pipes, and sediment load equals runoff
  times concentration.
- **Invalid designs never reach the engine.** The same rules run in the
  editor as you draw and in the API before a simulation, so a design that
  couldn't be built never produces numbers.
- **The 3D view is honest about what is real.** Water, runoff paths, pipe
  flow and spray come from the time series; building heights, trees, the sky
  and thunder are labelled as illustration.
- **Fully local.** No API keys or external services: the engine ships inside
  the Python wheel, and Docker reproduces the reference results exactly.

## Limitations

The site is flat and made of rectangles. Costs and pollutant concentrations
are illustrative defaults, and the built-in year of rainfall is synthetic
(import a measured record for real decisions). There are no user accounts, so a public deployment needs a
password in front of it. The [methodology](METHODOLOGY.md) lists every
assumption.

## Résumé bullets (pick two or three)

- Built RunoffLab, a full-stack stormwater design tool that wraps EPA SWMM
  (Python/FastAPI, Next.js/TypeScript) so engineers can draw green
  infrastructure on a site plan and see its effect on runoff, peak flow and
  water quality.
- Implemented a parallel Pareto-front optimizer that evaluates 200 SWMM
  designs in about 5 seconds; on the sample site it found layouts cutting
  runoff by about 50 % within budget.
- Created a three.js storm replay driven by SWMM time series, with custom
  GLSL shaders, synthesised Web Audio and in-browser video export.
- Modelled five LID types and sediment/phosphorus washoff in SWMM, verified
  by 128 automated tests including checks against hand calculations;
  packaged with Docker.
