# ResillioX Python risk service

Python/FastAPI/Uvicorn performs risk inference; Express handles MQTT validation,
storage and realtime delivery. There is no trained model. `python-rules-v1`
is a configurable demonstration rules engine, version `1.0.0`.

From the repository root (Windows, with Python 3.13 available):

```powershell
python -m venv .docker-validation/python-venv
& .docker-validation/python-venv/Scripts/python.exe -m pip install -r ai_ml/requirements.lock.txt
$env:RISK_THRESHOLDS_JSON='{}'
# Optional: set the same private AI_SERVICE_TOKEN in Python and Express.
& .docker-validation/python-venv/Scripts/python.exe -m uvicorn ai_ml.main:app --host 127.0.0.1 --port 8000
```

Use `python3` and `.docker-validation/python-venv/bin/python` on Linux/macOS.
The lock file records tested dependencies; requirements.txt expresses supported
version ranges. No MongoDB credentials are needed by this service. Python owns
RISK_THRESHOLDS_JSON; it is not an untrusted request parameter. Examples use
demonstration thresholds that require validation on the actual installed sensors.

Endpoints:

- `GET /health`: engine/version health, explicitly `trained_model: false`.
- `POST /predict`: strict sensor input, structured score/classification,
  explanations, features, incidents, source and data-quality flags. If configured,
  send `Authorization: Bearer <AI_SERVICE_TOKEN>`; health stays public.

The input reuses firmware v1 names rather than introducing an illustrative second
`telemetry.temperature_c` format. Required: device_id, zone_id, building_id,
message_id, UTC timestamp ending Z, source hardware/simulation and sensors.
Optional: schema_version (`"1.0"`), firmware_version, health and
stale_after_seconds (default 120). Sensor keys: temperature, humidity, mq2_raw,
vibration_rms, sw420, pir, flame, sos. Numeric strings and numeric booleans are
rejected. Missing/null sensors are reported, not replaced with zero/false.
Unhealthy exact-field entries exclude those values. Out-of-range numeric values
become data-quality faults; unknown fields, nonfinite values and invalid types
are rejected. Bodies are limited to 16 KiB and validation errors omit raw inputs.

Example simulated input (refresh timestamp before use):

```json
{"message_id":"example-simulation-1","device_id":"sim_node_01","zone_id":"zoneA","building_id":"building01","timestamp":"2026-10-22T12:00:00Z","source":"simulation","sensors":{"temperature":42,"humidity":50,"mq2_raw":100,"vibration_rms":0.05,"sw420":false,"pir":false,"flame":false,"sos":false},"health":{}}
```

Output includes risk_score (0-100), risk_level (NORMAL/LOW/MODERATE/HIGH/CRITICAL),
hazards, incidents, features, data_quality, stale, analyzed_at, echoed identity,
model_version, engine_version and incident_cooldown_seconds. Express adapts field
names to the existing dashboard contract; it does not calculate the score.

Preprocessing removes missing, unhealthy and out-of-range values. Features use
only actual available inputs: threshold comparisons, humidity band and existing
firmware-computed dynamic vibration RMS. No raw acceleration stream is present,
so this service does not invent acceleration axes or recompute a raw MPU window.
MQ-2 is raw ADC, not ppm; vibration does not establish structural damage; PIR
alone does not establish intrusion. Stale/future-skewed readings keep historical
explanations but produce no fresh live incidents. All-missing data is a fault,
not a healthy NORMAL result. Source labels remain unchanged throughout.

The predictor protocol in inference.py is the extension point for a future
trained model. Rule configuration validates ordered thresholds/bands and bounded
weights. Defaults retain the earlier rule thresholds, with explicit humidity
band monitoring (20-80%) and actionable threshold incidents. Python is stateless;
Express deduplicates persisted events/incidents rather than keeping risk state
inside this HTTP service.

Tests:

```powershell
& .docker-validation/python-venv/Scripts/python.exe -m pytest ai_ml/tests -q
node backend/scripts/verify-integration.js --phase=5
```

The second command starts a temporary real Uvicorn service on loopback port
18001, tests health/normal/SOS/invalid HTTP requests, then stops its own process.
Set INTEGRATION_PYTHON if the workspace interpreter is elsewhere.

## Express integration and full verification

Start this Python service first, then start the existing backend with its private
MongoDB/operator/MQTT settings. A host backend uses:

```powershell
$env:AI_SERVICE_URL='http://127.0.0.1:8000'
$env:AI_TIMEOUT_MS='3000'
npm.cmd --prefix backend start
```

For Compose, `docker compose up -d --build` includes the new internal `ai_ml`
service. Use the existing `mqtt/compose.auth.yml` override and private MQTT env
file for LAN devices (see mqtt/README.md). Compose backend uses
`AI_SERVICE_URL=http://ai_ml:8000`; this hostname is not a host-process address.
No public Python port or frontend changes are required. Python's optional token
and Express's AI_SERVICE_TOKEN must match. Keep credentials out of VITE_ variables.
Container configuration is validated; Docker runtime/build is not verified here.

Express validates each Python response, including echoed device/message/zone,
source and timestamp, bounded score/types and version. Timeout, HTTP failure,
oversized/invalid response or identity mismatch yields no JavaScript fallback.
Valid telemetry is transactionally saved with analysisStatus unavailable and a
safe error code; no RiskAnalysis or inferred Alert is manufactured. MQTT is
acknowledged only after durable storage. A database write failure aborts the
transaction, withholds success broadcasts and allows broker redelivery.

Successful Python outputs are adapted to existing risk fields and saved in the
existing RiskAnalysis collection with modelVersion, engineVersion and features.
Alerts and device state are in the same transaction. Duplicate complete IDs are
idempotent. Redelivery of an unavailable-analysis ID retries Python using the
original saved payload, without overwriting telemetry. There is no background
historical re-analysis worker in this batch; unavailable records otherwise stay
explicitly unavailable. Persisted incident cooldown uses committed alerts and
survives process restart. A resolved incident can raise a new alert.

Existing APIs remain authenticated as before: /api/devices, /api/readings/latest,
/api/readings/history, /api/alerts, /api/alerts/active and /api/system/status.
Public /api/health and /api/health/ready include AI availability when v1 ingestion
requires Python; /api/health/live remains process liveness. Device/latest returns
risk null when the latest reading has no analysis, instead of attaching an older
prediction. The existing dashboard summary omits outdated risks for devices whose
latest reading has unavailable analysis. System status exposes safe failure and
reconnect counters. Successful Socket.IO events keep their existing names:
sensor_update, risk_update, new_alert, device_status, sos_event. Simulation source
labels are preserved; failed inference emits telemetry status without a fake risk.

Run the complete simulated local pipeline:

```powershell
node backend/scripts/verify-integration.js --phase=6
```

This uses installed Windows Mosquitto and MongoDB 8.2, plus the workspace Python
environment, on temporary loopback ports 18887/27028/18001. It refuses occupied
ports, creates fresh test credentials and an isolated MongoDB replica set, and
runs test files sequentially because broker fixtures share an ACL simulator ID.
Test databases have random resilliox_*_test_ names and are dropped by their test
cleanup; it never uses the private Atlas URI. Processes are stopped after tests.
Ignored .docker-validation/integration-* contains local test configuration/logs.
Override MOSQUITTO_DIRECTORY, INTEGRATION_MONGOD or INTEGRATION_PYTHON for another
installation. Database-less `npm.cmd --prefix backend test` keeps integration
cases gated. Unrelated camera/dashboard database suites remain gated in this
Phase 6 runner; this is not physical hardware or cloud-deployment verification.

The React frontend is untouched. Future UI work may surface the new unavailable
analysis state more prominently; this batch does not add a re-analysis worker,
trained model, camera firmware or any Phase 7+ feature.

## Multi-Label IoT Building Safety ML Model

The trained multi-label classifier is saved at:
`ai_ml/models/iot_building_safety_multilabel.joblib`

### Architecture & Capabilities:
- **Model Type:** Multi-output scikit-learn Random Forest ensemble with a reproducible `ColumnTransformer` preprocessing pipeline.
- **Targets (10 Independent Binary Outputs):**
  1. `event_fire_suspected`
  2. `event_smoke_suspected`
  3. `event_combustible_gas_suspected`
  4. `event_unauthorized_intrusion`
  5. `event_vibration_anomaly`
  6. `event_structural_vibration_review`
  7. `event_heat_risk`
  8. `event_high_humidity_mold_risk`
  9. `event_device_fault`
  10. `event_network_degradation`
- **Simultaneous Events:** Each sensor snapshot can activate multiple concurrent event labels without forcing a single mutually exclusive classification.
- **Hardware Emergency Override (SOS):** The physical hardware emergency button (`sos_button_pressed` / `event_sos_triggered`) is strictly excluded from the ML feature set. It executes as a deterministic, zero-latency emergency override that triggers immediately without relying on probabilistic model predictions.
- **Target Leakage Prevention:** Feature matrix excludes all labels, record IDs, split indicators, synthetic flags, scenario types, safety scores, alert priorities, buzzer commands, and recommended actions.

### Training Entry Point & Evaluation:
To retrain or re-evaluate the model from the workspace root:
```powershell
python ai_ml/train_multilabel.py
```
Primary dataset: `ai_ml/datasets/iot_building_safety_model_input_targets.csv` (12,000 rows, 50 columns; 8,400 train, 1,800 validation, 1,800 test).
Reports and predictions are written to:
- `ai_ml/analytics/multilabel_model_evaluation_report.md`
- `ai_ml/analytics/multilabel_model_evaluation_report.json`
- `ai_ml/analytics/held_out_test_predictions.csv`

### Invoking from Python Backend / Service:
```python
from ai_ml.inference import MultiLabelIoTModel, ModelLoader

# Method 1: Direct instantiation
model = MultiLabelIoTModel("ai_ml/models/iot_building_safety_multilabel.joblib")
prediction = model.predict_multi_label({
    "zone_id": "SERVER_ROOM",
    "monitoring_role": "SECURITY_ZONE",
    "temperature_c": 45.0,
    "mq2_adc_raw_0_4095": 2800,
    "flame_detected_normalized": 1,
})
print("Active Events:", prediction["active_events"])
print("Emergency Override (SOS):", prediction["emergency_override"])

# Method 2: Via ModelLoader
loader = ModelLoader("ai_ml/models/trained")
model = loader.load_multilabel_model()
```

### Running Automated Tests:
```powershell
pytest ai_ml/tests -v
```

Primary references: [FastAPI testing](https://fastapi.tiangolo.com/tutorial/testing/)
and [Pydantic strict mode](https://docs.pydantic.dev/latest/concepts/strict_mode/).
