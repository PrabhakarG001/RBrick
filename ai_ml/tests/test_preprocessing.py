import pytest
from ai_ml.preprocessing.validation import validate_telemetry_ranges
from ai_ml.preprocessing.feature_builder import build_features
from ai_ml.preprocessing.cleaning import clean_telemetry_batch

def test_validation_ranges():
    valid = validate_telemetry_ranges({"temperature": 25.5, "humidity": 60.0, "flame": False})
    assert valid["valid"] is True
    assert valid["cleaned"]["temperature"] == 25.5
    assert valid["cleaned"]["humidity"] == 60.0
    assert valid["cleaned"]["flame"] is False

def test_validation_out_of_bounds():
    invalid = validate_telemetry_ranges({"temperature": 999.0, "humidity": -50.0})
    assert "temperature" not in invalid["cleaned"]
    assert "humidity" not in invalid["cleaned"]
    assert len(invalid["notes"]) == 2

def test_feature_builder():
    feats = build_features({"temperature": 30.0, "humidity": 70.0, "gas": 200.0})
    assert "temperature_c" in feats
    assert "heat_index" in feats
    assert "gas_ratio" in feats

def test_cleaning_duplicates():
    batch = [
        {"deviceId": "dev1", "observedAt": "2026-10-22T10:00:00Z", "val": 1},
        {"deviceId": "dev1", "observedAt": "2026-10-22T10:00:00Z", "val": 1},
        {"deviceId": "dev1", "observedAt": "2026-10-22T10:01:00Z", "val": 2},
    ]
    cleaned = clean_telemetry_batch(batch)
    assert len(cleaned) == 2
