"""Year-long rainfall: a synthetic typical year, or a measured record imported from CSV.

Long-term (continuous) simulation answers a different question from a design
storm: what share of all the rain in a year a site keeps out of the pipes. It
needs a rainfall record. RunoffLab ships no observed data, so it offers:

* **A synthetic year** from a rectangular-pulse rainfall model: storms arrive
  at random (more often in the wetter season), last a random number of hours,
  and rain at a random intensity that varies hour to hour; the year is then
  scaled to the annual total you choose. This is the structure of the
  Poisson rectangular-pulse models of Rodriguez-Iturbe, Cox & Isham (1987). It
  is plausible, not observed: use a measured record for real decisions.
* **An imported record**, such as an hourly series from a weather station
  (e.g. NOAA's hourly precipitation data), parsed from CSV and summed to
  hourly depths.
"""

from __future__ import annotations

import csv
import io
import math
import random
from collections import Counter
from datetime import datetime, timedelta

from pydantic import BaseModel, Field

STEP_MINUTES = 60  # records are stored as hourly depths
MAX_HOURS = 2 * 366 * 24  # at most two years
SYNTHETIC_REFERENCE = ("Synthetic year from a Poisson rectangular-pulse model (cf. Rodriguez-Iturbe, Cox & Isham "
                       "1987), scaled to the chosen annual total. Plausible, not observed.")


class RainRecord(BaseModel):
    """Hourly rainfall depths, mm, starting at `start`."""
    name: str = Field(min_length=1, max_length=120)
    source: str  # "synthetic" or "imported"
    start: datetime
    step_minutes: int = STEP_MINUTES
    depths_mm: list[float] = Field(min_length=24, max_length=MAX_HOURS)

    @property
    def total_mm(self) -> float:
        return sum(self.depths_mm)

    @property
    def hours(self) -> int:
        return len(self.depths_mm)


def synthetic_year(annual_mm: float = 1000.0, seed: int = 1, year: int = 2024) -> RainRecord:
    """A year of hourly rain whose total is exactly `annual_mm`."""
    rand = random.Random(seed)
    start = datetime(year, 1, 1)
    hours = (datetime(year + 1, 1, 1) - start).days * 24
    depths = [0.0] * hours
    t = 0.0
    while True:
        # Storms are about 40 % more frequent in the wetter half of the year.
        season = 1 + 0.4 * math.cos(2 * math.pi * (t / hours - 0.1))
        t += rand.expovariate(1 / 72) / season  # about two storms a week on average
        if t >= hours:
            break
        duration = max(1, round(rand.expovariate(1 / 6)))  # mean ~6 h
        intensity = rand.expovariate(1.0)  # relative; scaled below
        for h in range(int(t), min(int(t) + duration, hours)):
            depths[h] += intensity * rand.gammavariate(2.0, 0.5)  # hour-to-hour variation
    scale = annual_mm / sum(depths)
    return RainRecord(name=f"Synthetic year, {annual_mm:g} mm", source="synthetic", start=start,
                      depths_mm=[round(d * scale, 3) for d in depths])


class RainfallParseError(ValueError):
    pass


_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
            "%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y-%m-%d")


def _parse_time(text: str) -> datetime:
    text = text.strip().rstrip("Z")
    for fmt in _FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    raise RainfallParseError(f"Couldn’t read the date/time “{text}”. Use e.g. 2023-05-01 13:00.")


def _looks_like_time(text: str) -> bool:
    try:
        _parse_time(text)
        return True
    except RainfallParseError:
        return False


def parse_csv(text: str, units: str = "mm", name: str = "Imported rainfall") -> RainRecord:
    """Parse `time,value` rows (a header row is fine) into hourly depths.

    `units` is what each value means: "mm" or "in" of rain in that row's interval,
    or "mm/h" / "in/h" intensity over that interval. Missing hours count as dry.
    """
    if units not in ("mm", "in", "mm/h", "in/h"):
        raise RainfallParseError("Units must be mm, in, mm/h or in/h.")
    rows: list[tuple[datetime, float]] = []
    for n, row in enumerate(csv.reader(io.StringIO(text))):
        if len(row) < 2 or not row[0].strip():
            continue
        try:
            value = float(row[1])
        except ValueError:
            if n == 0 and not _looks_like_time(row[0]):
                continue  # a header row such as "DATE,PRCP"
            raise RainfallParseError(f"Row {n + 1}: “{row[1].strip()}” isn’t a number.") from None
        if value < 0:
            raise RainfallParseError(f"Row {n + 1}: rainfall can’t be negative.")
        rows.append((_parse_time(row[0]), value))
    if len(rows) < 2:
        raise RainfallParseError("The file needs at least two rows of time and rainfall.")
    rows.sort()
    # The recording interval is the most common gap between readings.
    gaps = Counter((b[0] - a[0]).total_seconds() / 60 for a, b in zip(rows, rows[1:]) if b[0] > a[0])
    interval = gaps.most_common(1)[0][0] if gaps else 60
    if interval <= 0:
        raise RainfallParseError("Couldn’t work out the time between readings.")
    start = rows[0][0].replace(minute=0, second=0, microsecond=0)
    hours = math.ceil((rows[-1][0] - start).total_seconds() / 3600) + 1
    if hours > MAX_HOURS:
        raise RainfallParseError("Records longer than two years aren’t supported; trim the file.")
    depths = [0.0] * max(hours, 24)
    to_mm = 25.4 if units.startswith("in") else 1.0
    for t, v in rows:
        depth = v * to_mm * (interval / 60 if units.endswith("/h") else 1)
        depths[int((t - start).total_seconds() // 3600)] += depth
    return RainRecord(name=name[:120] or "Imported rainfall", source="imported", start=start,
                      depths_mm=[round(d, 3) for d in depths])
