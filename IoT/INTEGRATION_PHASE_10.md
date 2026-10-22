# Phase 10 - final software integration and testing

Scope: software simulation only. Physical ESP32, sensor wiring, ESP32-CAM and
buzzer operation remain unverified. No trained ML model is present; risk analysis
uses the existing Python/FastAPI `python-rules-v1` demonstration engine.

## Architecture inspected and retained

Python MQTT simulator -> authenticated Mosquitto -> existing Express v1 consumer
-> FastAPI /predict -> Express transaction -> MongoDB -> Socket.IO/REST -> React.
Express remains the coordinator. Existing collections, routes, UI, camera and
manual maintenance workflow are reused; no JavaScript inference fallback added.
The legacy JavaScript risk tests are historical coverage, not production scoring.

## Phase 10 changes

| File | Change |
|---|---|
| IoT/simulator/publish_test_data.py | Individual temperature, MQ-2, MPU6050 RMS, SW-420, PIR, flame, SOS, missing/invalid and online/offline scenarios; normal no random digital hazards; emergency fallback for all emergency scenarios; bounded initial connection attempts; argument validation |
| IoT/simulator/requirements.txt | Pin the existing simulator dependency, paho-mqtt 2.1.0 |
| IoT/simulator/README.md | Scenario behavior and examples |
| backend/test/pipeline.test.js | Real simulator CLI through MQTT/Python/Mongo/REST/sockets, continuous SOS fallback, Express/consumer restart, durable dedup and new analysis after restart |
| backend/scripts/verify-dashboard.js | Real Python simulator to React; individual sensor/missing states; desktop/mobile monitoring checks; retain only isolated test data for restart comparison |
| backend/scripts/verify-integration.js | Phase 10 runner; kill/restart owned Mongo, broker and Python; compare all persisted documents; rerun pipeline; fix cleanup waiting on already-closed child processes |
| ai_ml/risk_engine.py | Remove misleading word Physical from SOS explanation shared by hardware and simulation |
| IoT/README.md | Update simulator summary |
| DOCKER.md | Link Phase 10 results |
| IoT/INTEGRATION_PHASE_10.md | This report, demo and future hardware checklist |

No frontend application, layout, styles, routes, dependencies, backend schema,
MQTT contract, private credentials or hardware pin assignments changed.

## Executed commands

From the repository root, using the existing workspace virtual environment:

```powershell
& .docker-validation/python-venv/Scripts/python.exe -m pip install paho-mqtt==2.1.0
node backend/scripts/verify-integration.js --phase=10
node mqtt/verify-local-broker.cjs
& .docker-validation/python-venv/Scripts/python.exe -m pytest ai_ml/tests -q
node --test Frontend/test/safetyData.test.js
npm.cmd --prefix Frontend run build -- --outDir ../.docker-validation/frontend-phase10-build
```

The native runner needs Mosquitto executables, MongoDB 8.2, Python virtualenv,
installed existing frontend/backend packages and Chrome. Override paths using
INTEGRATION_PYTHON, INTEGRATION_MONGOD, MOSQUITTO_DIRECTORY, INTEGRATION_BROWSER.
It uses loopback ports 18887, 18001, 27028, 5179 and 9237; occupied ports are not
replaced. Random test credentials and databases are isolated from private .env
and Atlas. It stops only its owned processes. Screenshots and logs stay under
ignored .docker-validation; its temporary Mongo directory is removed on exit.
Allow sufficient disk space for Mongo's journal and its 500 MiB free-space guard.

## Test coverage and evidence

| Test | Verification |
|---|---|
| A normal | Actual Python simulator -> authenticated MQTT -> Express -> actual FastAPI -> Mongo -> REST/Socket.IO -> headless Chrome; simulation label, NORMAL score |
| B temperature | Isolated 72-74 C simulator scenario returns CRITICAL; live combined hazard test shows critical risk in React |
| C MQ-2 | 2700-2900 raw counts -> CRITICAL; raw ADC displayed in React, never ppm |
| D vibration | MPU RMS 2.7-3.0 -> HIGH; SW-420 -> LOW; visible RMS/trigger states; no structural damage assertion |
| E flame | Individual simulator -> CRITICAL factors; live flame alert displayed |
| F SOS | Simulated event persisted and socket notification; duplicates suppressed; continuous SOS falls back after one emergency cycle |
| G disconnect | Simulator status/availability, offline DB/socket/API state; stale observations shown honestly |
| H invalid | Invalid JSON, topic identity mismatch and string temperature rejected; null temperature with health missing stored and analyzed as a quality fault |
| I duplicate | Reading/event unique IDs and incident cooldown; altered redelivery cannot overwrite durable telemetry; restart dedup |
| J Python failure | HTTP 503, timeout, invalid/mismatched/oversized response; no fabricated current score; telemetry retained; safe redelivery recovery |
| K React reconnect | Browser offline while telemetry arrives; Socket.IO reconnect refetches authoritative data |
| L maintenance | Authorized manual approval, persisted alert/risk/location/source links, concurrent duplicate prevention, start/complete; no assignment feature exists |
| M restart | Express and MQTT consumer recreation; real owned Mongo/Mosquitto/Python processes stopped/restarted; all stored document hashes unchanged; complete MQTT/Python pipeline run after restart |

Camera coverage uses an explicitly simulated authenticated HTTP PNG endpoint,
not an ESP32-CAM. Existing tests verify saved bytes, refresh persistence and
upstream failure handling. Desktop 1440x1000 and mobile 390x844 are checked for
horizontal overflow and JavaScript runtime exceptions; screenshots are retained.

Final validation on 2026-10-22:

- Phase 10 native runner exited 0: 41 backend tests passed, zero failed/skipped;
  actual-browser checks passed; additional post-restart pipeline test passed.
- Python pytest: 22 passed. Frontend data-state helper: 1 passed.
- Authenticated Mosquitto CLI, invalid/anonymous credentials, cross-device ACL
  at both topic depths and retained offline Last Will: all four checks passed.
- Frontend production build passed (2702 modules). Node syntax checks passed
  for both verification scripts and pipeline.test.js.
- Test cases A-M above passed in the native simulation environment. No unresolved
  software test failure remains in this batch; Docker and hardware exclusions
  below still apply.
- Screenshots were visually reviewed:
  [desktop](../.docker-validation/dashboard-live-ef67ce51-5c12-41a0-9494-941c1b842cee/dashboard-1440.png)
  and [mobile](../.docker-validation/dashboard-live-ef67ce51-5c12-41a0-9494-941c1b842cee/dashboard-390.png).

Existing nonfatal warnings are a Starlette/httpx test-client deprecation and
Vite's >500 kB bundle advisory.

One repeat run failed four database cases because C: free space fell below
MongoDB's minimum. This exposed the runner cleanup bug after a service restart:
already-signaled children were still considered running, so their old close
events were awaited and database cleanup never finished. Filtering signalCode
as well as exitCode fixes it. Only verified inactive artifacts from this run
were removed before rerunning; no application database or user browser was touched.

The new continuous-simulation test initially used an internal Mongo $nin filter
without marking it trusted, which the existing sanitizeFilter setting correctly
rejected. The test now marks only its internally constructed filter trusted;
application filter sanitization remains enabled.
The new mobile monitoring assertion also initially looked for mixed-case labels
although existing CSS displays them uppercase. Only the test expectation changed;
the UI styling was preserved.

Docker engine probe returned `Docker Desktop is unable to start`. Container
build/start/network/health/restart checks remain blocked; native checks do not
claim to validate Docker runtime or the private Atlas connection.

## Repeatable unattended demonstration

Run `node backend/scripts/verify-integration.js --phase=10`. This starts all
isolated software services, exercises the scenarios, opens real React in headless
Chrome, saves screenshots, verifies restarts and exits. It intentionally removes
its temporary database; use a dedicated demo database for an interactive demo.

## Interactive startup (separate PowerShell terminals)

These are manual demo instructions, not a claim that a persistent demo is left
running. Reuse existing credentials; never rerun initializers over existing
secret files. From the repository root, initialize authentication only if absent
and generate the native broker config per mqtt/README.md:

```powershell
# Only if mqtt/.secrets does not yet exist:
powershell -NoProfile -ExecutionPolicy Bypass -File mqtt/Initialize-MqttAuth.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File mqtt/New-NativeConfig.ps1
# Terminal 1 - broker; do not start a second broker on an occupied port.
& 'C:\Program Files\mosquitto\mosquitto.exe' -c mqtt/.secrets/mosquitto.native.conf -v
```

Terminal 2 - use the existing Mongo replica set, or create a dedicated demo
instance only if port 27029 is free (choose a disk with sufficient free space):

```powershell
New-Item -ItemType Directory -Force .docker-validation/demo-mongo | Out-Null
& 'C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe' --replSet demo_rs --port 27029 --bind_ip 127.0.0.1 --dbpath .docker-validation/demo-mongo
```

Once only, in another terminal initialize that new instance; an existing set
must not be reinitialized. This loopback demo instance has no database auth:

```powershell
@'
import mongoose from './backend/node_modules/mongoose/index.js';
const c=new mongoose.mongo.MongoClient('mongodb://127.0.0.1:27029/?directConnection=true');
await c.connect();
try {
  await c.db('admin').command({replSetInitiate:{_id:'demo_rs',members:[{_id:0,host:'127.0.0.1:27029'}]}});
} finally { await c.close(); }
'@ | node --input-type=module
```

Keep private backend .env values valid, including a strong operator IOT_API_TOKEN.
For the dedicated demo set MONGODB_URI to
`mongodb://127.0.0.1:27029/?replicaSet=demo_rs`, DB_NAME=resilliox_demo,
MONGODB_TLS=false, MQTT_ENABLED=true, MQTT_PAYLOAD_FORMAT=resilliox-v1,
MQTT_URL=mqtt://127.0.0.1:1883 and AI_SERVICE_URL=http://127.0.0.1:8000.
Atlas instead requires its original URI and TLS=true; do not mix these settings.
Wait until the replica set is primary. Keep credentials out of frontend settings.

Terminal 3 - Python. If AI_SERVICE_TOKEN is configured, securely set the same
private value in this terminal as in Express; Python does not load root .env:

```powershell
$env:RISK_THRESHOLDS_JSON='{}'
& .docker-validation/python-venv/Scripts/python.exe -m uvicorn ai_ml.main:app --host 127.0.0.1 --port 8000
```

Terminal 4 - import the backend-only MQTT env file without printing its values:

```powershell
Get-Content mqtt/.secrets/backend.env | ForEach-Object {
  $pair=$_ -split '=',2
  if($pair.Length -eq 2){[Environment]::SetEnvironmentVariable($pair[0],$pair[1],'Process')}
}
npm.cmd --prefix backend start
```

Terminal 5 - existing React development server:

```powershell
$env:API_PROXY_TARGET='http://127.0.0.1:5000'
$env:VITE_API_URL='/api'
npm.cmd --prefix Frontend run dev -- --host 127.0.0.1
```

Terminal 6 - simulator, using its separate account, not the backend account:

```powershell
& .docker-validation/python-venv/Scripts/python.exe -m pip install -r IoT/simulator/requirements.txt
$env:MQTT_USERNAME='simulator'
$entry=Get-Content mqtt/.secrets/device-credentials.txt | Where-Object {$_ -like 'simulator=*'}
$env:MQTT_PASSWORD=($entry -split '=',2)[1]
& .docker-validation/python-venv/Scripts/python.exe IoT/simulator/publish_test_data.py --scenario normal --duration 30
```

Open the Vite URL and /dashboard; enter the private operator token in its existing
connection form. Show normal live readings and Python rule version, then run
temperature, mq2, mpu6050, sw420, pir, flame and sos using `--scenario <name>
--once`. Each one-shot cleanly goes offline, so explain the offline indicator.
Use continuous normal mode while presenting live data. Show simulated SOS,
Incidents details, history/risk evidence, approve a maintenance request manually,
then Start and Complete it. Demonstrate missing and invalid scenarios and confirm
invalid telemetry adds no stored reading. Stop normal publishing to show offline.
Restart only the chosen demo services with their original data directories,
then reconnect and check the same IDs. Do not remove volumes or demo data to restart.

## Future hardware checklist (pending)

- Confirm exact ESP32 and ESP32-CAM board models, sensor breakout labels,
  voltage levels, MPU6050 address and active/passive buzzer type.
- Review GPIOs, ADC voltage protection, boot-strapping pins, I2C pins and power
  budget before setting pinsReviewed=true. Current pins remain -1; no wiring
  is inferred from a successful reference-board compile.
- Validate MQ-2 warmup/baseline/ADC response, DHT22 reference readings, MPU bias
  and RMS window, digital polarity/debounce and installation-specific Python
  thresholds. Default thresholds are demonstration rules, not calibration.
- Configure Wi-Fi, device-specific MQTT credentials, actual laptop LAN host,
  topic IDs, firmware version and NTP in ignored config.local.h. Devices must
  not use localhost or Docker service hostnames. Restrict the broker to the
  trusted LAN or configure TLS for the relevant deployment.
- Use the existing resilliox-v1 JSON example in IoT/README.md and schema in
  backend/src/services/telemetrySchema.js. All eight fields are required;
  missing sensors use null plus exact-field unhealthy health. Use fresh UTC Z
  timestamps and unique message IDs. Telemetry/events QoS1, never retained;
  status and availability retained, offline Last Will.
- Stop the simulator; use the real firmware's distinct esp32_main_01 identity,
  hardware source and account/ACL. Do not relabel synthetic messages as hardware.
  The dashboard already distinguishes hardware, simulation and unknown source.
- Current v1 includes DHT22, MQ-2, MPU RMS, SW-420, PIR, flame and SOS. Earlier
  project history mentioned water/door sensors; they are not in this current
  v1 contract and were not tested or silently added in Phase 10.
- ESP32-CAM still needs board-specific firmware/pins/power, private reachable
  snapshot URL, per-camera token if supported, camera/status heartbeat and
  source hardware. Configure server-only CAMERA_SNAPSHOT_URLS_JSON and optional
  CAMERA_BEARER_TOKENS_JSON; do not expose images or credentials in MQTT payloads.
- Physical pending tests: actual measurements, safe hazard stimulus, SOS/button
  debounce, local buzzer response, Wi-Fi loss/Last Will, power-cycle recovery,
  clock sync, actual camera images and incident-to-camera location association.
  No physical or guaranteed hazard-prevention claim is made.
