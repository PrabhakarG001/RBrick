import pytest
from ai_ml.inference.model_loader import ModelLoader
from ai_ml.inference.anomaly_detector import StatisticalAnomalyDetector

def test_model_loader_fallback():
    loader = ModelLoader("models/trained")
    meta = loader.discover_and_load()
    assert meta["loaded"] is False
    assert "statistical" in meta["engine"]

def test_statistical_anomaly_detector():
    detector = StatisticalAnomalyDetector(zscore_threshold=2.0)
    # 10 baseline readings around 20.0, 1 outlier at 80.0
    readings = [
        {"deviceId": "dev1", "observedAt": f"2026-10-22T10:0{i}:00Z", "sensors": {"temperature": 20.0 + (i % 2)}}
        for i in range(9)
    ]
    readings.append({"deviceId": "dev1", "observedAt": "2026-10-22T10:10:00Z", "sensors": {"temperature": 80.0}})

    anomalies = detector.detect_anomalies(readings, "temperature")
    assert len(anomalies) == 1
    assert anomalies[0]["value"] == 80.0
    assert anomalies[0]["severity"] == "critical"
