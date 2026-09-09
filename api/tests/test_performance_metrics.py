import pytest

from app.performance_metrics import (
    DERIVED_IMPRESSIONS_KEY,
    GBP_SOURCE_METRICS,
    IMPRESSION_COMPONENTS,
    METRIC_REGISTRY_VERSION,
    metric_definition,
)


def test_registry_contains_exactly_the_eight_proven_source_keys():
    assert GBP_SOURCE_METRICS == (
        "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
        "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
        "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
        "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
        "BUSINESS_DIRECTION_REQUESTS",
        "BUSINESS_FOOD_MENU_CLICKS",
        "CALL_CLICKS",
        "WEBSITE_CLICKS",
    )


def test_derived_total_declares_its_four_components_and_is_not_a_source_key():
    definition = metric_definition(DERIVED_IMPRESSIONS_KEY)
    assert definition.kind == "derived"
    assert definition.components == IMPRESSION_COMPONENTS
    assert DERIVED_IMPRESSIONS_KEY not in GBP_SOURCE_METRICS


def test_unknown_metric_key_is_rejected():
    with pytest.raises(KeyError):
        metric_definition("BUSINESS_BOOKINGS")


def test_registry_version_is_pinned():
    assert METRIC_REGISTRY_VERSION == "seo_ops.performance_metrics.v1"
