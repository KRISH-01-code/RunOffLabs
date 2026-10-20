"use client";

import { useState } from "react";
import { num } from "@/lib/format";
import type { WaterBalance } from "@/lib/types";
import { niceTicks, useWidth } from "./useWidth";

interface Entry { key: string; label: string; color: string; balance: WaterBalance }

const ROWS: { key: keyof WaterBalance; label: string }[] = [
  { key: "infiltration_mm", label: "Infiltrated" },
  { key: "runoff_mm", label: "Ran off" },
  { key: "evaporation_mm", label: "Evaporated" },
  { key: "storage_change_mm", label: "Still stored" },
];

const BAR = 14;
const BAR_GAP = 2;
const ROW_GAP = 18;
const LABEL_W = 84;
const VALUE_W = 56;

/** Where the rain went: grouped horizontal bars, depth over the whole site (mm). */
export default function BalanceChart({ entries }: { entries: Entry[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(320);
  const [hover, setHover] = useState<string | null>(null);

  const max = Math.max(...entries.flatMap((e) => ROWS.map((r) => Math.max(e.balance[r.key], 0))));
  const ticks = niceTicks(max, 3);
  const xMax = ticks.at(-1)!;
  const innerW = width - LABEL_W - VALUE_W;
  const xw = (v: number) => (Math.max(v, 0) / xMax) * innerW;
  const groupH = entries.length * BAR + (entries.length - 1) * BAR_GAP;
  const height = ROWS.length * (groupH + ROW_GAP) + 20;

  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="Water balance, baseline versus proposed">
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "baseline" : "gridline"} x1={LABEL_W + xw(t)} x2={LABEL_W + xw(t)} y1={0} y2={height - 20} />
            <text className="tick" x={LABEL_W + xw(t)} y={height - 4} textAnchor="middle">{num(t)}</text>
          </g>
        ))}
        {ROWS.map((row, ri) => {
          const y0 = ri * (groupH + ROW_GAP) + ROW_GAP / 2;
          return (
            <g key={row.key}>
              <text x={0} y={y0 + groupH / 2 + 4} fontSize={12} fill="var(--ink-2)">{row.label}</text>
              {entries.map((e, ei) => {
                const v = e.balance[row.key];
                const y = y0 + ei * (BAR + BAR_GAP);
                const w = xw(v);
                const id = `${row.key}-${e.key}`;
                return (
                  <g key={e.key} onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover(null)}>
                    <title>{`${e.label} · ${row.label}: ${num(v, 1)} mm`}</title>
                    <rect x={LABEL_W} y={y - BAR_GAP / 2} width={innerW + VALUE_W} height={BAR + BAR_GAP} fill="transparent" />
                    {w > 0.5 && (
                      <path d={roundedRight(LABEL_W, y, w, BAR, Math.min(4, w))} fill={e.color}
                            opacity={hover && hover !== id ? 0.55 : 1} />
                    )}
                    <text x={LABEL_W + w + 6} y={y + BAR / 2 + 4} fontSize={11.5} fill="var(--ink)" className="num">
                      {num(v, 1)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Bar with a 4px rounded data end and a square baseline end. */
function roundedRight(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
