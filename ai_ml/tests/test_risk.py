from copy import deepcopy
from datetime import datetime, timedelta, timezone
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from ai_ml.main import app
from ai_ml.schemas import PredictionInput
from ai_ml.model_config import RuleConfig, load_config
from ai_ml.risk_engine import analyze

@pytest.fixture
def payload():
    return {"schema_version": "1.0", "message_id": "simulation-test-1", "device_id": "sim_node_01",
        "building_id": "building01", "zone_id": "zoneA", "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "simulation", "firmware_version": "test-1",
        "sensors": {"temperature": 24, "humidity": 50, "mq2_raw": 100, "vibration_rms": 0.05,
                    "sw420": False, "pir": False, "flame": False, "sos": False}, "health": {}}

@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("RISK_THRESHOLDS_JSON", "{}")
    with TestClient(app) as client:
        yield client

def test_health_and_normal_prediction(client, payload):
    assert client.get("/health").json()["trained_model"] is False
    response = client.post("/predict", json=payload)
    assert response.status_code == 200
    result = response.json()
    assert result["risk_score"] == 0
    assert result["risk_level"] == "NORMAL"
    assert result["hazards"] == []
    assert result["source"] == "simulation"
    assert result["model_version"] == "python-rules-v1"

@pytest.mark.parametrize("field,value,kind,level", [
    ("temperature", 42, "ELEVATED_TEMPERATURE", "MODERATE"),
    ("temperature", 75, "ELEVATED_TEMPERATURE", "CRITICAL"),
    ("humidity", 90, "HUMIDITY_OUTSIDE_BAND", "LOW"),
    ("mq2_raw", 2600, "GAS_SMOKE_INDICATOR", "CRITICAL"),
    ("vibration_rms", 3, "VIBRATION_INDICATOR", "HIGH"),
    ("sw420", True, "VIBRATION_SWITCH", "LOW"),
    ("flame", True, "POTENTIAL_FLAME", "CRITICAL"),
    ("sos", True, "SOS", "CRITICAL"),
])
def test_hazards(client, payload, field, value, kind, level):
    payload["sensors"][field] = value
    result = client.post("/predict", json=payload).json()
    assert result["risk_level"] == level
    assert any(h["type"] == kind for h in result["hazards"])
    assert result["incidents"]
    assert 0 <= result["risk_score"] <= 100

def test_pir_is_informational(client, payload):
    payload["sensors"]["pir"] = True
    result = client.post("/predict", json=payload).json()
    assert result["incidents"] == []
    assert result["hazards"][0]["informational"] is True

def test_missing_unhealthy_and_range_faults(client, payload):
    payload["sensors"] = {"sos": True, "temperature": 200}
    payload["health"] = {"sos": "error"}
    result = client.post("/predict", json=payload).json()
    assert result["risk_level"] == "LOW"
    assert result["data_quality"]["invalid"] == [{"field": "temperature", "reason": "out_of_range"}]
    assert result["data_quality"]["distrusted"] == [{"field": "sos", "health": "error"}]
    assert "humidity" in result["data_quality"]["missing"]
    assert all(h["type"] != "SOS" for h in result["hazards"])
    assert "sos" not in result["features"]

def test_null_and_empty_data_never_looks_healthy(client, payload):
    payload["sensors"] = {"temperature": None}
    result = client.post("/predict", json=payload).json()
    assert len(result["data_quality"]["missing"]) == 8
    assert result["risk_level"] != "NORMAL"

@pytest.mark.parametrize("field,value", [("temperature", "42"), ("temperature", True), ("sos", 1), ("pir", "false")])
def test_invalid_types_rejected_without_echo(client, payload, field, value):
    payload["sensors"][field] = value
    response = client.post("/predict", json=payload)
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid sensor telemetry"}

@pytest.mark.parametrize("offset", [-600, 600])
def test_stale_or_future_data_has_no_live_incidents(client, payload, offset):
    payload["timestamp"] = (datetime.now(timezone.utc) + timedelta(seconds=offset)).isoformat().replace("+00:00", "Z")
    payload["sensors"]["sos"] = True
    result = client.post("/predict", json=payload).json()
    assert result["stale"] is True
    assert result["incidents"] == []
    assert result["risk_level"] == "CRITICAL"  # Clearly historical, not fabricated safe.

def test_timestamp_source_unknown_fields_and_nonfinite_validation(client, payload):
    for change in [{"source": "live"}, {"timestamp": "2026-01-01T00:00:00"},
                   {"extra": "unsupported"}, {"timestamp": 1234}]:
        assert client.post("/predict", json=payload | change).status_code == 422
    broken = deepcopy(payload)
    broken["sensors"]["mq2_raw"] = float("inf")
    with pytest.raises(ValidationError):
        PredictionInput.model_validate(broken)

def test_configuration_and_determinism(monkeypatch, payload):
    monkeypatch.setenv("RISK_THRESHOLDS_JSON", '{"temperature":{"warning":30}}')
    rules = load_config()
    assert rules.temperature.high == 55
    payload["sensors"]["temperature"] = 35
    reading = PredictionInput.model_validate(payload)
    now = datetime.now(timezone.utc)
    assert analyze(reading, rules, now) == analyze(reading, rules, now)
    assert analyze(reading, rules, now).risk_level == "MODERATE"
    monkeypatch.setenv("RISK_THRESHOLDS_JSON", '{"temperature":{"warning":100}}')
    with pytest.raises(ValidationError): load_config()

def test_saturation(client, payload):
    payload["sensors"].update(temperature=75, mq2_raw=4000, flame=True, sos=True, sw420=True, vibration_rms=3)
    assert client.post("/predict", json=payload).json()["risk_score"] == 100

def test_optional_service_authentication_and_body_limit(monkeypatch, payload):
    monkeypatch.setenv("AI_SERVICE_TOKEN", "test-private-service-token")
    with TestClient(app) as secured:
        assert secured.get("/health").status_code == 200
        assert secured.post("/predict", json=payload).status_code == 401
        assert secured.post("/predict", json=payload, headers={"Authorization": "Bearer test-private-service-token"}).status_code == 200
        assert secured.post("/predict", content="x" * 17000).status_code == 413
