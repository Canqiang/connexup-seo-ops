"""The only place that names GBP metric keys and the derived impressions rule."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Context, ROUND_HALF_EVEN
from typing import Literal

METRIC_REGISTRY_VERSION = "seo_ops.performance_metrics.v1"
CALCULATION_CONTEXT = Context(prec=28, rounding=ROUND_HALF_EVEN)

GBP_SOURCE_METRICS: tuple[str, ...] = (
    "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
    "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
    "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
    "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
    "BUSINESS_DIRECTION_REQUESTS",
    "BUSINESS_FOOD_MENU_CLICKS",
    "CALL_CLICKS",
    "WEBSITE_CLICKS",
)
IMPRESSION_COMPONENTS: tuple[str, ...] = GBP_SOURCE_METRICS[:4]
DERIVED_IMPRESSIONS_KEY = "gbp_impressions_total"

DISPLAY_LABELS: dict[str, str] = {
    DERIVED_IMPRESSIONS_KEY: "GBP 曝光",
    "WEBSITE_CLICKS": "官网点击",
    "CALL_CLICKS": "电话按钮点击",
    "BUSINESS_DIRECTION_REQUESTS": "路线请求",
    "BUSINESS_FOOD_MENU_CLICKS": "菜单浏览",
    "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": "桌面地图展示",
    "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": "桌面搜索展示",
    "BUSINESS_IMPRESSIONS_MOBILE_MAPS": "移动地图展示",
    "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": "移动搜索展示",
}

# Headline metrics shown as KPI cards, in display order.
HEADLINE_METRICS: tuple[str, ...] = (
    DERIVED_IMPRESSIONS_KEY,
    "WEBSITE_CLICKS",
    "CALL_CLICKS",
    "BUSINESS_DIRECTION_REQUESTS",
)


@dataclass(frozen=True)
class MetricDefinition:
    metric_key: str
    kind: Literal["source", "derived"]
    source: Literal["GBP"]
    unit: Literal["count"]
    label: str
    components: tuple[str, ...] = ()


_REGISTRY: dict[str, MetricDefinition] = {
    key: MetricDefinition(key, "source", "GBP", "count", DISPLAY_LABELS[key])
    for key in GBP_SOURCE_METRICS
}
_REGISTRY[DERIVED_IMPRESSIONS_KEY] = MetricDefinition(
    DERIVED_IMPRESSIONS_KEY,
    "derived",
    "GBP",
    "count",
    DISPLAY_LABELS[DERIVED_IMPRESSIONS_KEY],
    IMPRESSION_COMPONENTS,
)


def metric_definition(metric_key: str) -> MetricDefinition:
    return _REGISTRY[metric_key]


def known_metric_keys() -> tuple[str, ...]:
    return tuple(_REGISTRY)
