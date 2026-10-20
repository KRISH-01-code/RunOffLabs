"use client";

import { useId } from "react";
import type { Design, Site } from "@/lib/types";
import { LIDS } from "@/lib/lids";

/** A small read-only plan of the site with one design's interventions. */
export default function SitePreview({ site, design, label }: { site: Site; design: Design | null; label: string }) {
  const uid = useId().replace(/:/g, "");
  const pad = 2;
  return (
    <svg viewBox={`${-pad} ${-pad} ${site.width_m + 2 * pad} ${site.height_m + 2 * pad}`} role="img" aria-label={label}
         style={{ display: "block", width: "100%", height: "auto", background: "var(--map-bg)", borderRadius: 8 }}>
      <defs>
        <pattern id={`rg-${uid}`} patternUnits="userSpaceOnUse" width="3" height="3">
          <rect width="3" height="3" fill="var(--rg-fill)" />
          <circle cx="0.8" cy="0.9" r="0.42" fill="var(--rg-plant)" opacity="0.55" />
        </pattern>
        <pattern id={`pp-${uid}`} patternUnits="userSpaceOnUse" width="2.4" height="2.4" patternTransform="rotate(45)">
          <rect width="2.4" height="2.4" fill="var(--pp-fill)" />
          <line x1="0" y1="0" x2="0" y2="2.4" stroke="var(--pp-stroke)" strokeWidth="0.7" opacity="0.55" />
        </pattern>
      </defs>
      {site.surfaces.map((s) => (
        <rect key={s.id} x={s.rect.x} y={s.rect.y} width={s.rect.width} height={s.rect.height}
              fill={`var(--kind-${s.kind})`} stroke="var(--surface)" strokeWidth={0.6} />
      ))}
      {design?.interventions.map((i) => (
        <rect key={i.id} x={i.rect.x} y={i.rect.y} width={i.rect.width} height={i.rect.height}
              rx={i.kind === "rain_barrel" ? Math.min(i.rect.width, i.rect.height) / 2 : 0}
              fill={i.kind === "rain_garden" ? `url(#rg-${uid})` : i.kind === "permeable_pavement" ? `url(#pp-${uid})` : LIDS[i.kind].fill}
              stroke={LIDS[i.kind].stroke} strokeWidth={0.8} />
      ))}
    </svg>
  );
}
