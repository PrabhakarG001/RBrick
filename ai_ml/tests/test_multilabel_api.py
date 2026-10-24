"""
Test suite for FastAPI multi-label inference endpoints (/predict/multilabel and /models/multilabel/info).
"""

from fastapi.testclient import TestClient
from ai_ml.main import app


def test_multilabel_model_info():
    with TestClient(app) as client:
        res = client.get("/models/multilabel/info")
        assert res.status_code == 200
        data = res.json()
        assert data["loaded"] is True
        assert data["engine"] == "iot-building-safety-multilabel"
        assert data["feature_count"] == 38
        assert data["target_count"] == 10
        assert len(data["target_names"]) == 10


def test_multilabel_predict_valid_esp32_payload():
    with TestClient(app) as client:
        payload = {
            "building": "building-1",
            "area": "zone-1",
            "temperature": 24.5,
            "humidity": 55.0,
            "gas_value": 300,
            "fire": 0,
            "motion": 0,
            "sos": 0,
            "wifi_rssi": -65,
        }
        res = client.post("/predict/multilabel", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert "predicted_labels" in data
        assert len(data["predicted_labels"]) == 10
        assert "probabilities" in data
        assert len(data["probabilities"]) == 10
        assert data["emergency_override"] is False
        assert data["active_event_count"] == 0
        assert data["sensor_coverage"]["supplied_count"] > 0
        assert data["sensor_coverage"]["total_count"] == 38
        assert data["sensor_coverage"]["coverage_status"] == "reduced"


def test_multilabel_predict_multiple_simultaneous_events():
    with TestClient(app) as client:
        # High heat + fire + high gas
        payload = {
            "building": "building-1",
            "area": "zone-1",
            "temperature_c": 58.0,
            "humidity_rh_pct": 88.0,
            "mq2_adc_raw_0_4095": 2900,
            "flame_detected_normalized": 1,
            "pir_motion_detected": 1,
            "wifi_rssi_dbm": -88,
        }
        res = client.post("/predict/multilabel", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert data["active_event_count"] >= 2
        assert len(data["active_events"]) >= 2
        for ev in data["active_events"]:
            assert data["predicted_labels"][ev] == 1


def test_multilabel_predict_sos_override_independent():
    with TestClient(app) as client:
        # All normal values, but SOS pressed
        payload = {
            "building": "building-1",
            "area": "zone-1",
            "temperature": 22.0,
            "humidity": 45.0,
            "gas_value": 200,
            "fire": 0,
            "motion": 0,
            "sos": 1,
            "wifi_rssi": -60,
        }
        res = client.post("/predict/multilabel", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert data["emergency_override"] is True
        assert data["sos_triggered"] is True


def test_multilabel_predict_missing_coverage_reporting():
    with TestClient(app) as client:
        # Only temperature sent
        payload = {"temperature": 22.0}
        res = client.post("/predict/multilabel", json=payload)
        assert res.status_code == 200
        data = res.json()
        coverage = data["sensor_coverage"]
        assert coverage["supplied_count"] == 1
        assert "temperature_c" in coverage["supplied_features"]
        assert "mq2_adc_raw_0_4095" in coverage["missing_features"]
        assert coverage["coverage_status"] == "reduced"
        assert coverage["missing_count"] == 37


def test_multilabel_predict_actual_esp32_firmware_payload():
    with TestClient(app) as client:
        # Representative payload from actual ESP32 firmware
        firmware_payload = {
            "building": "Engineering-Tower",
            "area": "Lab-204",
            "fire": "SAFE",
            "smoke": "NORMAL",
            "gas_value": 450,
            "motion": "NONE",
            "vibration": "NORMAL",
            "tilt": 1.25,
            "temperature": 24.5,
            "humidity": 45.0,
            "sos": False,
            "mpu_connected": True,
            "alarm": "NORMAL",
            "buzzer_on": False,
            "wifi_rssi": -65,
        }
        res = client.post("/predict/multilabel", json=firmware_payload)
        assert res.status_code == 200
        data = res.json()

        # Model coverage accurately counts the 7 supplied model features
        coverage = data["sensor_coverage"]
        assert coverage["supplied_count"] == 7
        assert coverage["total_count"] == 38
        assert coverage["coverage_pct"] == 18.42
        assert coverage["is_reduced_coverage"] is True

        # Features verified
        assert set(coverage["supplied_features"]) == {
            "zone_id", "temperature_c", "humidity_rh_pct",
            "mq2_adc_raw_0_4095", "pir_motion_detected",
            "flame_detected_normalized", "wifi_rssi_dbm"
        }

        # Tilt, vibration and mpu_connected are NOT falsely mapped into model features
        assert "sw420_digital_state" in coverage["missing_features"]
        assert "mpu_ax_g" in coverage["missing_features"]
        assert "vibration" not in coverage["supplied_features"]
        assert "tilt" not in coverage["supplied_features"]

        # Device health extracted separately
        health = data["device_health"]
        assert health["mpu_connected"] is True
        assert health["buzzer_on"] is False
        assert health["alarm"] == "NORMAL"
        assert health["vibration"] == "NORMAL"
        assert health["tilt"] == 1.25


def test_multilabel_predict_esp32_danger_and_detected():
    with TestClient(app) as client:
        # Flame danger and motion detected
        firmware_danger = {
            "building": "Tower-C",
            "area": "Boiler-Room",
            "fire": "DANGER",
            "smoke": "HIGH",
            "gas_value": 3100,
            "motion": "DETECTED",
            "vibration": "NORMAL",
            "temperature": 55.0,
            "humidity": 40.0,
            "sos": False,
            "mpu_connected": True,
            "alarm": "FIRE",
            "buzzer_on": True,
            "wifi_rssi": -72,
        }
        res = client.post("/predict/multilabel", json=firmware_danger)
        assert res.status_code == 200
        data = res.json()
        assert data["events"]["event_fire_suspected"]["predicted"] is True
        assert data["events"]["event_fire_suspected"]["probability"] >= data["events"]["event_fire_suspected"]["threshold"]


def test_multilabel_predict_rejects_malformed_values():
    with TestClient(app) as client:
        # Invalid fire string must not be silently treated as safe
        bad_fire = {"fire": "BURNING", "temperature": 25.0}
        res1 = client.post("/predict/multilabel", json=bad_fire)
        assert res1.status_code == 400
        assert "Invalid fire value" in res1.json()["detail"]

        # Invalid motion string must not be silently treated as safe
        bad_motion = {"motion": "RUNNING", "temperature": 25.0}
        res2 = client.post("/predict/multilabel", json=bad_motion)
        assert res2.status_code == 400
        assert "Invalid motion value" in res2.json()["detail"]


def test_multilabel_predict_null_temperature_and_humidity():
    with TestClient(app) as client:
        # Null readings for temperature and humidity
        payload = {
            "building": "Tower-A",
            "area": "Lobby",
            "fire": "SAFE",
            "motion": "NONE",
            "gas_value": 300,
            "temperature": None,
            "humidity": None,
            "wifi_rssi": -60,
        }
        res = client.post("/predict/multilabel", json=payload)
        assert res.status_code == 200
        data = res.json()
        coverage = data["sensor_coverage"]
        # Exactly 5 features supplied (zone_id, gas_value, motion, fire, wifi_rssi)
        assert coverage["supplied_count"] == 5
        assert "temperature_c" in coverage["missing_features"]
        assert "humidity_rh_pct" in coverage["missing_features"]
        assert coverage["coverage_pct"] == 13.16

