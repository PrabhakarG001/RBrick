# ResillioX IoT layer

- `firmware/esp32_main/`: modular Arduino ESP32 firmware, reference build tested;
  GPIO assignment and physical validation remain pending.
- `simulator/`: Python/paho MQTT simulator with individual Phase 10 scenarios, always
  labeled `source: "simulation"`.
- `INTEGRATION_PHASES_1_3.md`: architecture audit and phase-by-phase results.

Firmware uses `source: "hardware"` only for real sampled data. Disabled or failed
sensors produce null, never synthetic readings. See `firmware/README.md` for
configuration, build, upload, sampling, wiring prerequisites and physical tests.
No trained ML model is implemented. Phase 6 uses the Python/FastAPI rule engine
in `ai_ml/`; the old JavaScript rules remain a historical test reference, with
no production inference import or fallback. See `INTEGRATION_PHASES_4_6.md`.

## Existing resilliox-v1 contract

Authoritative schema: `backend/src/services/telemetrySchema.js`. Reuse string
`schema_version: "1.0"` and nested `sensors`, rather than introducing a second
schema/consumer based on the prompt's illustrative example.

Canonical topic: `building/{zone_id}/{device_id}/telemetry`. Existing
`building/{building_id}/{zone_id}/{device_id}/telemetry` remains supported.
Events, status, availability and camera/status follow the same prefix.

The following is an explicitly simulated schema example, not a measurement:

```json
{
  "schema_version": "1.0",
  "message_id": "example-simulation-1",
  "device_id": "sim_node_01",
  "building_id": "building01",
  "zone_id": "zone01",
  "timestamp": "2026-10-22T12:00:00Z",
  "source": "simulation",
  "firmware_version": "example",
  "sensors": {
    "temperature": 24.5,
    "humidity": 60.1,
    "mq2_raw": null,
    "vibration_rms": 0.12,
    "sw420": false,
    "pir": false,
    "flame": false,
    "sos": false
  },
  "health": {
    "temperature": "ok", "humidity": "ok", "mq2_raw": "missing",
    "vibration_rms": "ok", "sw420": "ok", "pir": "ok",
    "flame": "ok", "sos": "ok"
  }
}
```

- All eight sensor fields are required. Unavailable fields use null and an
  exact-field `health` entry (`missing`, `error` or `degraded`). Null without an
  unhealthy flag is rejected. Healthy false/zero remains a genuine value.
- The four digital fields are booleans when available; the others are finite
  numbers. MPU vibration is dynamic three-axis RMS in g; MQ-2 is raw ADC, not ppm.
- Health is keyed by telemetry field (`temperature`, `mq2_raw`, etc.), not module
  label (`dht22`, `mq2`). Existing risk normalization already excludes unhealthy
  values; its scoring algorithm was not changed.
- UTC timestamps end in Z. A unique message_id identifies each envelope, including
  QoS 1 retries. Firmware waits for a valid network clock before publishing.
- Telemetry/events: QoS 1, never retained. Firmware SOS events use the same
  envelope without firmware_version/sensors/health, adding
  `event: {"kind":"sos","detail":"Debounced physical SOS button pressed..."}`.
- Retained JSON status adds firmware_version and state online/offline/degraded.
  Retained availability uses plain online/offline; offline is the broker Last Will.
- Camera status uses schema_version/message_id/device_id/timestamp/source/state
  and optional ip/uptime_s. Camera streaming and ESP32-CAM firmware are not added
  in these phases; the exact camera board is unconfirmed.

## Simulator

```powershell
python -m pip install 'paho-mqtt>=2,<3'
python IoT/simulator/publish_test_data.py --duration 30
```

Use its existing README/options for broker credentials and scenarios. Simulator
and device credentials are separate. No simulation data is inserted into the
production database by the firmware build or transport verification.
