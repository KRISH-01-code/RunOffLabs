"""Site and design constraint checks.

A design that fails any `error` check is never sent to SWMM: the API returns
the issues instead of results, so an infeasible layout cannot silently
produce numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

from runofflab.hydrology.surfaces import (
    GREEN_ROOF_HOSTS,
    IMPERVIOUS_KINDS,
    PERMEABLE_PAVEMENT_HOSTS,
    RAIN_BARREL_HOSTS,
    RAIN_GARDEN_HOSTS,
    TRENCH_HOSTS,
    SurfaceKind,
)
from runofflab.models.project import (
    CAPTURING,
    Constraints,
    CostAssumptions,
    Design,
    GreenRoof,
    InfiltrationTrench,
    PermeablePavement,
    RainBarrel,
    RainGarden,
    Rect,
    Site,
)

# Display name and allowed host surfaces for each intervention type.
KINDS = {
    RainGarden: ("Rain garden", RAIN_GARDEN_HOSTS),
    PermeablePavement: ("Permeable pavement", PERMEABLE_PAVEMENT_HOSTS),
    GreenRoof: ("Green roof", GREEN_ROOF_HOSTS),
    InfiltrationTrench: ("Infiltration trench", TRENCH_HOSTS),
    RainBarrel: ("Rain barrel", RAIN_BARREL_HOSTS),
}
AnyIntervention = RainGarden | PermeablePavement | GreenRoof | InfiltrationTrench | RainBarrel

EPS = 1e-6


class Issue(BaseModel):
    severity: Literal["error", "warning"]
    code: str
    message: str
    target_id: str | None = None


def _overlap_area(a: Rect, b: Rect) -> float:
    w = min(a.x2, b.x2) - max(a.x, b.x)
    h = min(a.y2, b.y2) - max(a.y, b.y)
    return w * h if w > EPS and h > EPS else 0.0


def _contains(outer: Rect, inner: Rect) -> bool:
    return (inner.x >= outer.x - EPS and inner.y >= outer.y - EPS
            and inner.x2 <= outer.x2 + EPS and inner.y2 <= outer.y2 + EPS)


def _gap(a: Rect, b: Rect) -> float:
    """Shortest distance between two rectangles (0 if they touch or overlap)."""
    dx = max(b.x - a.x2, a.x - b.x2, 0.0)
    dy = max(b.y - a.y2, a.y - b.y2, 0.0)
    return (dx * dx + dy * dy) ** 0.5


def validate_site(site: Site) -> list[Issue]:
    issues: list[Issue] = []

    def err(code: str, msg: str, target: str | None = None) -> None:
        issues.append(Issue(severity="error", code=code, message=msg, target_id=target))

    ids = [s.id for s in site.surfaces] + [i.id for i in site.inlets] + [site.outfall.id] \
        + [p.id for p in site.pipes]
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        err("duplicate_id", f"The id '{dup}' is used more than once.", dup)

    bounds = Rect(x=0, y=0, width=site.width_m, height=site.height_m)
    inlet_ids = {i.id for i in site.inlets}
    for s in site.surfaces:
        if not _contains(bounds, s.rect):
            err("surface_outside_site", f"{s.name} extends beyond the site boundary.", s.id)
        if s.drains_to not in inlet_ids:
            err("unknown_inlet", f"{s.name} drains to unknown inlet '{s.drains_to}'.", s.id)
    for i, a in enumerate(site.surfaces):
        for b in site.surfaces[i + 1:]:
            if _overlap_area(a.rect, b.rect) > 0:
                err("surface_overlap", f"{a.name} overlaps {b.name}.", b.id)

    for node in [*site.inlets, site.outfall]:
        if not (-EPS <= node.x <= site.width_m + EPS and -EPS <= node.y <= site.height_m + EPS):
            err("node_outside_site", f"{node.name} is outside the site boundary.", node.id)

    # Land with no surface on it isn't part of the model at all, so say so.
    covered = sum(s.area_m2 for s in site.surfaces) - sum(
        _overlap_area(a.rect, b.rect) for i, a in enumerate(site.surfaces) for b in site.surfaces[i + 1:])
    uncovered = bounds.area - covered
    if uncovered > max(1.0, 0.001 * bounds.area):
        issues.append(Issue(
            severity="warning", code="site_not_covered",
            message=f"{uncovered:,.0f} m² of the site has no surface drawn on it, so rain there isn't modelled."))

    # Pipes should fall towards the outfall; one running uphill only flows once it backs up.
    inverts = {i.id: i.invert_elev_m for i in site.inlets} | {site.outfall.id: site.outfall.invert_elev_m}
    for p in site.pipes:
        if p.from_node in inverts and p.to_node in inverts and inverts[p.to_node] >= inverts[p.from_node]:
            issues.append(Issue(
                severity="warning", code="pipe_adverse_slope",
                message=f"Pipe {p.id} doesn't fall from {p.from_node} to {p.to_node}; lower the "
                        f"downstream invert so water can drain.", target_id=p.id))

    # Every inlet must reach the outfall through the pipe network.
    node_ids = inlet_ids | {site.outfall.id}
    downstream: dict[str, str] = {}
    for p in site.pipes:
        if p.from_node not in node_ids or p.to_node not in node_ids:
            err("unknown_node", f"Pipe {p.id} connects unknown nodes.", p.id)
            continue
        if p.from_node == site.outfall.id:
            err("pipe_from_outfall", f"Pipe {p.id} starts at the outfall.", p.id)
        downstream.setdefault(p.from_node, p.to_node)
    for inlet in site.inlets:
        seen, node = set(), inlet.id
        while node != site.outfall.id and node in downstream and node not in seen:
            seen.add(node)
            node = downstream[node]
        if node != site.outfall.id:
            err("inlet_not_connected", f"{inlet.name} has no pipe path to the outfall.", inlet.id)
    return issues


@dataclass
class DesignCheck:
    """Outcome of checking a design: issues plus derived quantities."""
    issues: list[Issue] = field(default_factory=list)
    host_surface: dict[str, str] = field(default_factory=dict)  # intervention -> surface
    area_by_kind: dict[str, float] = field(default_factory=dict)  # footprint m² per intervention kind
    cost: float = 0.0

    @property
    def rain_garden_area_m2(self) -> float:
        return self.area_by_kind.get("rain_garden", 0.0)

    @property
    def permeable_pavement_area_m2(self) -> float:
        return self.area_by_kind.get("permeable_pavement", 0.0)

    @property
    def total_area_m2(self) -> float:
        return sum(self.area_by_kind.values())

    @property
    def feasible(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)


def intervention_cost(item: AnyIntervention, costs: CostAssumptions) -> float:
    if isinstance(item, RainBarrel):  # priced by tank volume
        return item.rect.area * item.height_mm / 1000 * costs.rain_barrel_per_m3
    rate = {
        RainGarden: costs.rain_garden_per_m2, PermeablePavement: costs.permeable_pavement_per_m2,
        GreenRoof: costs.green_roof_per_m2, InfiltrationTrench: costs.infiltration_trench_per_m2,
    }[type(item)]
    return item.rect.area * rate


def check_design(site: Site, design: Design, costs: CostAssumptions,
                 constraints: Constraints) -> DesignCheck:
    check = DesignCheck()

    def err(code: str, msg: str, target: str | None = None) -> None:
        check.issues.append(Issue(severity="error", code=code, message=msg, target_id=target))

    ids = [i.id for i in design.interventions]
    surface_ids = {s.id for s in site.surfaces}
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        err("duplicate_id", f"Intervention id '{dup}' is used more than once.", dup)
    for clash in sorted(set(ids) & surface_ids):
        err("duplicate_id", f"Intervention id '{clash}' clashes with a surface id.", clash)

    # Impervious area each surface still has available to route into LIDs.
    routed: dict[str, float] = {}
    paved_over: dict[str, float] = {}

    for item in design.interventions:
        label, allowed = KINDS[type(item)]
        host = next((s for s in site.surfaces if _contains(s.rect, item.rect)), None)
        if host is None:
            err("not_within_surface",
                f"{label} {item.id} must sit entirely inside a single surface.", item.id)
        elif host.kind not in allowed:
            kinds = ", ".join(sorted(k.value for k in allowed))
            err("wrong_host_surface",
                f"{label} {item.id} is on {host.name} ({host.kind.value}); allowed: {kinds}.", item.id)
        else:
            check.host_surface[item.id] = host.id

        check.cost += intervention_cost(item, costs)
        check.area_by_kind[item.kind] = check.area_by_kind.get(item.kind, 0.0) + item.rect.area

        if isinstance(item, CAPTURING):
            src = site.surface(item.contributing_surface_id)
            barrel = isinstance(item, RainBarrel)
            if src is None:
                err("unknown_surface", f"{label} {item.id} drains an unknown surface.", item.id)
            elif barrel and src.kind is not SurfaceKind.ROOF:
                err("contributing_not_roof", f"Rain barrel {item.id} must collect from a roof.", item.id)
            elif src.kind not in IMPERVIOUS_KINDS:
                err("contributing_not_impervious",
                    f"{label} {item.id} must capture runoff from an impervious surface.", item.id)
            else:
                if host is not None and _gap(host.rect, src.rect) > constraints.max_contributing_gap_m:
                    err("contributing_too_far",
                        f"{src.name} is more than {constraints.max_contributing_gap_m:g} m from "
                        f"{label.lower()} {item.id}'s location.", item.id)
                routed[src.id] = routed.get(src.id, 0.0) + item.captured_area_m2
            ratio = item.captured_area_m2 / item.rect.area
            if not barrel and ratio > constraints.max_rain_garden_loading_ratio + EPS:
                err("loading_ratio",
                    f"{label} {item.id} captures {ratio:.1f}× its own area; the limit is "
                    f"{constraints.max_rain_garden_loading_ratio:g}×.", item.id)
            if item.captured_area_m2 == 0:
                check.issues.append(Issue(
                    severity="warning", code="no_capture",
                    message=f"{label} {item.id} captures no runoff; it only treats rain falling on it.",
                    target_id=item.id))
        elif item.id in check.host_surface:
            # Pavement and green roofs replace part of their host, so it has less left to route.
            paved_over[host.id] = paved_over.get(host.id, 0.0) + item.rect.area
            if isinstance(item, PermeablePavement):
                routed[host.id] = routed.get(host.id, 0.0) + item.runon_area_m2
        if isinstance(item, PermeablePavement):
            ratio = item.runon_area_m2 / item.rect.area
            if ratio > constraints.max_pavement_runon_ratio + EPS:
                err("runon_ratio",
                    f"Permeable pavement {item.id} receives run-on from {ratio:.1f}× its own area; "
                    f"the limit is {constraints.max_pavement_runon_ratio:g}×.", item.id)

    # Interventions may not overlap each other.
    items = design.interventions
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            if _overlap_area(a.rect, b.rect) > 0:
                err("intervention_overlap", f"{a.id} overlaps {b.id}.", b.id)

    # A surface cannot route more impervious area than it has left after paving.
    for sid, area in routed.items():
        surface = site.surface(sid)
        available = surface.area_m2 - paved_over.get(sid, 0.0)
        if area > available + EPS:
            err("over_capture",
                f"Interventions capture {area:,.0f} m² from {surface.name}, which has only "
                f"{available:,.0f} m² of remaining impervious area.", sid)

    if check.cost > constraints.budget + EPS:
        err("over_budget",
            f"Estimated cost {costs.currency} {check.cost:,.0f} exceeds the budget of "
            f"{costs.currency} {constraints.budget:,.0f}.")
    cap = constraints.max_intervention_area_m2
    if cap is not None and check.total_area_m2 > cap + EPS:
        err("over_area",
            f"Interventions cover {check.total_area_m2:,.0f} m²; the available space is {cap:,.0f} m².")
    return check
