"""
Automated Test Suite for ResillioX Multi-Label IoT Building Safety Model.

Verifies:
1. Successful import of dependencies.
2. Loading of saved model artifact.
3. Feature schema and order consistency.
4. Ten independent binary event predictions.
5. Multiple simultaneous positive event predictions.
6. Sample with zero predicted ML events (NORMAL).
7. Robust handling of missing sensor values and unknown categorical values.
8. Prevention of target and dashboard output leakage into feature matrix.
9. Deterministic SOS emergency override independent of the classifier.
10. Integration with ModelLoader and BaseModelInterface.
11. Repeated model loading and inference determinism.
"""

from pathlib import Path
import pytest
import numpy as np
import pandas as pd

from ai_ml.inference.multilabel_model import MultiLabelIoTModel, DEFAULT_MODEL_PATH
from ai_ml.inference.model_loader import ModelLoader
from ai_ml.schemas import PredictionInput


@pytest.fixture
def model():
    assert DEFAULT_MODEL_PATH.exists(), f"Model artifact not found at {DEFAULT_MODEL_PATH}"
    m = MultiLabelIoTModel(DEFAULT_MODEL_PATH)
    assert m.is_loaded is True
    return m


def test_dependency_imports():
    """Verify all critical ML dependencies import cleanly."""
    import joblib
    import numpy as np
    import pandas as pd
    import sklearn
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.compose import ColumnTransformer

    assert joblib is not None
    assert np is not None
    assert pd is not None
    assert sklearn is not None


def test_load_saved_artifact(model):
    """Verify the artifact can be loaded and metadata matches specification."""
    meta = model.get_metadata()
    assert meta["loaded"] is True
    assert meta["engine"] == "iot-building-safety-multilabel"
    assert meta["model_version"] == "iot-building-safety-multilabel-v1.0.0"
    assert meta["feature_count"] == 38
    assert meta["target_count"] == 10
    assert "disclaimer" in meta
    assert "Simulated synthetic sensor dataset only" in meta["disclaimer"]


def test_feature_schema_and_order(model):
    """Verify feature names match expected schema and order."""
    expected_features = [
        'zone_id', 'monitoring_role', 'zone_restricted', 'is_after_hours', 'authorized_access_window',
        'mpu_ax_g', 'mpu_ay_g', 'mpu_az_g', 'mpu_accel_magnitude_g', 'mpu_accel_delta_from_baseline_g',
        'mpu_gx_dps', 'mpu_gy_dps', 'mpu_gz_dps', 'mpu_gyro_magnitude_dps',
        'sw420_digital_state', 'sw420_pulse_count_10s', 'vibration_duration_s',
        'temperature_c', 'humidity_rh_pct', 'humidity_high_duration_min',
        'mq2_adc_raw_0_4095', 'mq2_baseline_adc', 'mq2_delta_from_baseline_pct',
        'pir_motion_detected', 'flame_detected_normalized', 'flame_adc_raw_0_4095',
        'esp32_cam_frame_ok', 'camera_motion_score_0_100', 'camera_person_confidence_0_100',
        'camera_smoke_confidence_0_100', 'camera_flame_confidence_0_100',
        'esp32_3v3_rail_v', 'esp32_board_temp_c',
        'wifi_rssi_dbm', 'packet_loss_pct', 'mqtt_latency_ms',
        'sensor_read_fail_count', 'sensor_values_stale_sec'
    ]
    assert model.feature_names == expected_features


def test_target_leakage_prevention(model):
    """Verify no forbidden target, dashboard, or metadata columns exist in feature set."""
    forbidden = {
        "record_id", "synthetic_flag", "data_split", "timestamp_utc", "scenario_type",
        "sos_button_pressed", "event_sos_triggered", "active_event_count", "active_event_labels",
        "safety_score_0_100", "safety_color", "alert_priority", "buzzer_command", "recommended_action",
    }
    forbidden.update(model.target_names)

    for feat in model.feature_names:
        assert feat not in forbidden, f"Target or dashboard leakage detected in feature: {feat}"


def test_ten_independent_binary_predictions(model):
    """Verify prediction output returns exactly 10 independent binary event outputs."""
    sample = {f: 0.0 for f in model.feature_names}
    sample["zone_id"] = "SERVER_ROOM"
    sample["monitoring_role"] = "SECURITY_ZONE"

    result = model.predict_multi_label(sample)
    labels = result["predicted_labels"]
    probas = result["probabilities"]

    assert len(labels) == 10
    assert len(probas) == 10
    for tgt in model.target_names:
        assert tgt in labels
        assert labels[tgt] in (0, 1)
        assert 0.0 <= probas[tgt] <= 1.0


def test_multiple_simultaneous_events(model):
    """Verify that a single input row can activate multiple simultaneous safety events."""
    # Input simulating severe fire + smoke + heat
    sample = {
        "zone_id": "SERVER_ROOM",
        "monitoring_role": "SECURITY_ZONE",
        "zone_restricted": 1,
        "is_after_hours": 1,
        "authorized_access_window": 0,
        "temperature_c": 48.5,
        "humidity_rh_pct": 30.0,
        "mq2_adc_raw_0_4095": 3800,
        "mq2_baseline_adc": 500,
        "mq2_delta_from_baseline_pct": 660.0,
        "flame_detected_normalized": 1,
        "flame_adc_raw_0_4095": 120,
        "camera_smoke_confidence_0_100": 95.0,
        "camera_flame_confidence_0_100": 98.0,
        "esp32_cam_frame_ok": 1,
    }
    result = model.predict_multi_label(sample)
    active = result["active_events"]

    assert len(active) >= 2, f"Expected multiple simultaneous events, got: {active}"
    assert "event_fire_suspected" in active
    assert "event_heat_risk" in active or "event_smoke_suspected" in active


def test_zero_events_normal_prediction(model):
    """Verify that a benign, healthy sensor reading activates zero ML events."""
    sample = {
        "zone_id": "MAIN_CORRIDOR",
        "monitoring_role": "SECURITY_ZONE",
        "zone_restricted": 0,
        "is_after_hours": 0,
        "authorized_access_window": 1,
        "temperature_c": 22.0,
        "humidity_rh_pct": 45.0,
        "humidity_high_duration_min": 0,
        "mq2_adc_raw_0_4095": 450,
        "mq2_baseline_adc": 450,
        "mq2_delta_from_baseline_pct": 0.0,
        "pir_motion_detected": 0,
        "flame_detected_normalized": 0,
        "flame_adc_raw_0_4095": 3500,
        "sw420_digital_state": 0,
        "sw420_pulse_count_10s": 0,
        "vibration_duration_s": 0.0,
        "mpu_accel_magnitude_g": 1.0,
        "mpu_accel_delta_from_baseline_g": 0.001,
        "esp32_cam_frame_ok": 1,
        "camera_motion_score_0_100": 0.0,
        "camera_person_confidence_0_100": 0.0,
        "camera_smoke_confidence_0_100": 0.0,
        "camera_flame_confidence_0_100": 0.0,
        "esp32_3v3_rail_v": 3.3,
        "esp32_board_temp_c": 35.0,
        "wifi_rssi_dbm": -50,
        "packet_loss_pct": 0.0,
        "mqtt_latency_ms": 25,
        "sensor_read_fail_count": 0,
        "sensor_values_stale_sec": 0.5,
    }
    result = model.predict_multi_label(sample)
    assert result["active_event_count"] == 0
    assert result["active_events"] == []
    assert result["emergency_override"] is False


def test_missing_and_unknown_categoricals(model):
    """Verify that unknown categoricals and missing sensor values are safely imputed."""
    # Incomplete dictionary with novel unknown zone_id
    sample = {
        "zone_id": "FUTURE_UNSEEN_ZONE_999",
        "monitoring_role": "NOVEL_ROLE",
        "temperature_c": 24.0,
        # Omit all other 36 features
    }
    result = model.predict_multi_label(sample)
    assert "predicted_labels" in result
    assert len(result["predicted_labels"]) == 10


def test_deterministic_sos_override(model):
    """
    Verify that hardware SOS button triggers emergency override immediately,
    even when ML model predicts zero events.
    """
    normal_sample_with_sos = {
        "zone_id": "MAIN_CORRIDOR",
        "monitoring_role": "SECURITY_ZONE",
        "temperature_c": 21.0,
        "humidity_rh_pct": 45.0,
        "sos_button_pressed": 1,  # Hardware button pressed
    }
    result = model.predict_multi_label(normal_sample_with_sos)

    # ML event predictions remain objective (no fire/intrusion)
    assert result["predicted_labels"]["event_fire_suspected"] == 0
    # But deterministic emergency override is immediately active!
    assert result["emergency_override"] is True
    assert result["sos_triggered"] is True

    # Test via BaseModelInterface predict_anomaly
    anomaly_result = model.predict_anomaly(normal_sample_with_sos)
    assert anomaly_result["is_anomaly"] is True
    assert anomaly_result["emergency_override"] is True
    assert "emergency_sos_button" in anomaly_result["factor_attributions"]


def test_model_loader_multilabel_integration():
    """Verify ModelLoader loads the multi-label model while keeping fallback intact."""
    loader = ModelLoader("models/trained")
    # Existing fallback behavior
    fallback_meta = loader.discover_and_load()
    assert fallback_meta["loaded"] is False

    # Multi-label model loading
    loaded_model = loader.load_multilabel_model()
    assert loaded_model is not None
    assert loader.loaded_model is not None
    assert loader.model_metadata["loaded"] is True
    assert loader.model_metadata["target_count"] == 10


def test_repeated_model_loading_and_inference(model):
    """Verify repeated loading and inference is completely deterministic."""
    sample = {
        "zone_id": "SERVER_ROOM",
        "monitoring_role": "SECURITY_ZONE",
        "temperature_c": 42.0,
        "mq2_adc_raw_0_4095": 1200,
    }
    res1 = model.predict_multi_label(sample)
    res2 = model.predict_multi_label(sample)

    assert res1["probabilities"] == res2["probabilities"]
    assert res1["predicted_labels"] == res2["predicted_labels"]
    assert res1["active_events"] == res2["active_events"]
