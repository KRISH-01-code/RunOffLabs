import { describe, expect, it } from "vitest";
import { hhmm, m3, money, pctChange, signedPct } from "@/lib/format";

describe("formatting", () => {
  it("formats volumes, money and clock times", () => {
    expect(m3(1234.4)).toBe("1,234 m³");
    expect(money(240000, "USD")).toBe("$240,000");
    expect(money(5, "NOTACURRENCY")).toBe("NOTACURRENCY 5");
    expect(hhmm(725)).toBe("12:05");
  });

  it("signs percentage changes with a true minus and guards a zero base", () => {
    expect(signedPct(pctChange(576, 826)!)).toBe("−30 %");
    expect(signedPct(12.4)).toBe("+12 %");
    expect(signedPct(0)).toBe("±0 %");
    expect(pctChange(5, 0)).toBeNull();
  });
});
