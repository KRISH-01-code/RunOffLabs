const nf = (digits: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const num = (v: number, digits = 0) => nf(digits).format(v);

export const m2 = (v: number) => `${num(v)} m²`;
export const m3 = (v: number) => `${num(v)} m³`;
export const m3s = (v: number) => `${num(v, 3)} m³/s`;
export const mm = (v: number, digits = 1) => `${num(v, digits)} mm`;

export function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 })
      .format(v);
  } catch {
    return `${currency} ${num(v)}`;
  }
}

/** Signed percentage change from `base` to `value`, or null when base is ~0. */
export function pctChange(value: number, base: number): number | null {
  return Math.abs(base) < 1e-9 ? null : ((value - base) / base) * 100;
}

export const signedPct = (p: number) => `${p > 0 ? "+" : p < 0 ? "−" : "±"}${num(Math.abs(p), 0)} %`;

/** "12:35" style clock label for minutes since storm start. */
export function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}
