"use client";

import { num } from "@/lib/format";
import type { Action } from "@/lib/store";
import type { Project, Reference, SoilTexture, StormPattern } from "@/lib/types";
import { NumberField } from "./ui";
import YearRainfall from "./YearRainfall";

const PATTERNS: { value: StormPattern; label: string }[] = [
  { value: "scs_type_ii", label: "SCS Type II (24 h)" },
  { value: "triangular", label: "Triangular" },
  { value: "uniform", label: "Uniform (block)" },
];

export function ScenarioPanel({ project, reference, dispatch }: {
  project: Project; reference: Reference | null; dispatch: (a: Action) => void;
}) {
  const sc = project.scenario;
  const set = (patch: Partial<Project["scenario"]>) => dispatch({ type: "setScenario", patch });
  const soil = reference?.soils[project.site.soil];
  const fixed24 = sc.pattern === "scs_type_ii";

  return (
    <>
      <section className="section" aria-labelledby="h-storm">
        <h3 id="h-storm">Design storm</h3>
        <div className="field">
          <label htmlFor="pattern">Rainfall pattern</label>
          <select id="pattern" className="select" value={sc.pattern}
                  onChange={(e) => set({ pattern: e.target.value as StormPattern })}>
            {PATTERNS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {reference && <span className="ref">{reference.rainfall_references[sc.pattern]}</span>}
        </div>
        <div className="grid-2">
          <NumberField label="Total depth" unit="mm" value={sc.depth_mm} min={1} max={500}
                       onChange={(v) => v !== null && set({ depth_mm: v })} />
          <NumberField label="Duration" unit="h" value={fixed24 ? 24 : sc.duration_hr} min={0.25} max={72} step={0.25}
                       disabled={fixed24} onChange={(v) => v !== null && set({ duration_hr: v })}
                       hint={fixed24 ? "Fixed at 24 h for SCS Type II" : undefined} />
        </div>
        {sc.pattern === "triangular" && (
          <NumberField label="Peak position" value={sc.peak_position} min={0.05} max={0.95} step={0.05}
                       onChange={(v) => v !== null && set({ peak_position: v })}
                       hint="Fraction of the storm duration before the peak intensity" />
        )}
        <p className="ref">
          RunoffLab doesn’t ship return-period depths. Look up the depth for your location and return period
          in local intensity–duration–frequency data, such as NOAA Atlas 14 in the US.
        </p>
      </section>

      <section className="section" aria-labelledby="h-soil">
        <h3 id="h-soil">Soil &amp; infiltration</h3>
        <div className="field">
          <label htmlFor="soil">Native soil texture</label>
          <select id="soil" className="select" value={project.site.soil}
                  onChange={(e) => dispatch({ type: "setSoil", soil: e.target.value as SoilTexture })}>
            {reference
              ? (Object.entries(reference.soils) as [SoilTexture, Reference["soils"][SoilTexture]][]).map(([k, v]) => (
                  <option key={k} value={k}>{v.label} · {num(v.ksat_mm_per_hr, 2)} mm/h</option>
                ))
              : <option value={project.site.soil}>{project.site.soil}</option>}
          </select>
        </div>
        {soil && (
          <dl className="kv">
            <dt>Saturated conductivity</dt><dd>{num(soil.ksat_mm_per_hr, 2)} mm/h</dd>
            <dt>Suction head</dt><dd>{num(soil.suction_head_mm, 1)} mm</dd>
            <dt>Initial moisture deficit</dt><dd>{num(soil.initial_moisture_deficit, 3)}</dd>
          </dl>
        )}
        <NumberField label="Infiltration factor" unit="×" value={sc.infiltration_factor} min={0.05} max={5} step={0.05}
                     onChange={(v) => v !== null && set({ infiltration_factor: v })}
                     hint="Multiplies native-soil and LID seepage rates. Below 1 models compaction or clogging." />
        <NumberField label="Drain time after rain" unit="h" value={sc.drain_hours} min={1} max={72}
                     onChange={(v) => v !== null && set({ drain_hours: v })}
                     hint="Extra simulated hours so stored water can drain" />
      </section>

      <YearRainfall project={project} dispatch={dispatch} />
    </>
  );
}

export function AssumptionsPanel({ project, reference, dispatch }: {
  project: Project; reference: Reference | null; dispatch: (a: Action) => void;
}) {
  const { costs, constraints } = project;
  const setC = (patch: Partial<Project["constraints"]>) => dispatch({ type: "setConstraints", patch });
  const cur = costs.currency;

  return (
    <>
      <section className="section" aria-labelledby="h-costs">
        <h3 id="h-costs">Unit costs</h3>
        <div className="grid-2">
          <NumberField label="Rain garden" unit={`${cur}/m²`} value={costs.rain_garden_per_m2} min={0}
                       onChange={(v) => v !== null && dispatch({ type: "setCosts", patch: { rain_garden_per_m2: v } })} />
          <NumberField label="Permeable pavement" unit={`${cur}/m²`} value={costs.permeable_pavement_per_m2} min={0}
                       onChange={(v) => v !== null && dispatch({ type: "setCosts", patch: { permeable_pavement_per_m2: v } })} />
          <NumberField label="Green roof" unit={`${cur}/m²`} value={costs.green_roof_per_m2} min={0}
                       onChange={(v) => v !== null && dispatch({ type: "setCosts", patch: { green_roof_per_m2: v } })} />
          <NumberField label="Infiltration trench" unit={`${cur}/m²`} value={costs.infiltration_trench_per_m2} min={0}
                       onChange={(v) => v !== null && dispatch({ type: "setCosts", patch: { infiltration_trench_per_m2: v } })} />
          <NumberField label="Rain barrel / cistern" unit={`${cur}/m³`} value={costs.rain_barrel_per_m3} min={0}
                       onChange={(v) => v !== null && dispatch({ type: "setCosts", patch: { rain_barrel_per_m3: v } })}
                       hint="Per cubic metre of tank" />
        </div>
        <p className="ref">Defaults are illustrative placeholders, not quotes. Use local installed costs.</p>
      </section>

      <section className="section" aria-labelledby="h-limits">
        <h3 id="h-limits">Constraints</h3>
        <div className="grid-2">
          <NumberField label="Budget" unit={cur} value={constraints.budget} min={0}
                       onChange={(v) => v !== null && setC({ budget: v })} />
          <NumberField label="Max intervention area" unit="m²" value={constraints.max_intervention_area_m2} min={0}
                       onChange={(v) => setC({ max_intervention_area_m2: v })} hint="Blank = no limit" />
          <NumberField label="Garden & trench loading" unit="×" value={constraints.max_rain_garden_loading_ratio} min={0.1}
                       onChange={(v) => v !== null && setC({ max_rain_garden_loading_ratio: v })}
                       hint="Max captured area ÷ footprint, for rain gardens and trenches" />
          <NumberField label="Pavement run-on" unit="×" value={constraints.max_pavement_runon_ratio} min={0}
                       onChange={(v) => v !== null && setC({ max_pavement_runon_ratio: v })}
                       hint="Max run-on area ÷ pavement area" />
          <NumberField label="Max capture distance" unit="m" value={constraints.max_contributing_gap_m} min={0}
                       onChange={(v) => v !== null && setC({ max_contributing_gap_m: v })}
                       hint="Paved surface to garden location" />
        </div>
      </section>

      {reference && (
        <section className="section" aria-labelledby="h-surfaces">
          <h3 id="h-surfaces">Surface parameters</h3>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Surface</th><th>Impervious</th><th>Manning n</th><th>Storage</th></tr></thead>
              <tbody>
                {Object.entries(reference.surfaces).map(([k, v]) => (
                  <tr key={k}><td>{v.label}</td><td>{v.impervious_pct}%</td><td>{v.n_overland}</td><td>{v.depression_storage_mm} mm</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ref">Typical values from the EPA SWMM 5 User’s Manual, Appendix A. {reference.soil_reference}</p>
        </section>
      )}
    </>
  );
}
