import pytest
from ai_ml.analytics.statistics import compute_series_stats, calculate_zscore
from ai_ml.analytics.trends import analyze_trend
from ai_ml.analytics.risk_scoring import compute_zone_risk_ranking

def test_statistics_computation():
    stats = compute_series_stats([10.0, 20.0, 30.0, 40.0, 50.0])
    assert stats["count"] == 5
    assert stats["mean"] == 30.0
    assert stats["min"] == 10.0
    assert stats["max"] == 50.0

def test_zscore_calculation():
    z = calculate_zscore(50.0, 30.0, 10.0)
    assert z == 2.0

def test_trend_slope():
    points = [{"time": i, "value": i * 2.0} for i in range(10)]
    trend = analyze_trend(points)
    assert trend["direction"] == "increasing"
    assert trend["slope"] > 0

def test_zone_risk_ranking():
    zones = [
        {"zoneId": "Zone-A", "critical": 0, "warning": 2, "info": 1},
        {"zoneId": "Zone-B", "critical": 3, "warning": 4, "info": 0},
    ]
    ranked = compute_zone_risk_ranking(zones)
    assert ranked[0]["zoneId"] == "Zone-B"
    assert ranked[0]["riskLevel"] == "CRITICAL"
