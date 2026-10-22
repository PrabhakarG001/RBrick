# ResillioX integration: Phases 1-3

## Phase 1: inspected architecture and baseline

- Existing frontend: `Frontend/` (React/Vite); no replacement frontend is needed.
- Express app factory: `backend/src/app.js`; only `backend/src/server.js` starts
  the production HTTP server and selects one MQTT consumer (`flat` or `resilliox-v1`).
- MongoDB connection: `backend/src/config/database.js`; existing Mongoose models
  cover readings, devices, alerts, risk analyses, maintenance, and camera metadata.
- Socket.IO: `backend/src/services/realtime.js`, attached to the same HTTP server.
- MQTT: existing Mosquitto Compose service, `mqtt/` configuration, flat/v1 consumers,
  and Python simulator. Native Windows Mosquitto tools are also installed here.
- Risk analysis: `backend/src/services/riskEngine.js` is a deterministic JavaScript
  rules engine, not a trained ML model. No duplicate `ai_ml/` engine is needed.
- ESP32 firmware: absent before this task. Installed Arduino CLI and ESP32 core
  3.3.12 will be reused. The physical board/module variants are not yet confirmed.
- Environment configuration names were inspected without printing credentials.
  The private `.env` will not be changed or copied into firmware.
- Baseline command: `npm.cmd --prefix backend test` with database integration
  environment variables cleared: **25 passed, 3 skipped, 0 failed**.

Minimum integration changes: support requested short topics alongside existing
building-qualified topics, provide an authenticated broker profile without breaking
the loopback demo, allow explicitly unhealthy null sensor readings, and add modular
ESP32 firmware/configuration/build and hardware verification instructions.

No frontend, risk algorithm, camera API, database architecture, or additional HTTP
server will be created. Camera-stream/snapshot implementation is outside Phases 1-3.

## Phase reports

Phase 1 files created: this report. Files modified: none.
Checks: root/package/model/server/service/config inspection and existing backend tests.
Remaining: topic compatibility, authenticated broker verification, firmware build;
physical wiring/GPIO confirmation remains a required hardware gate.

### Phase 2 report

Created: `mqtt/mosquitto.auth.conf`, `mqtt/compose.auth.yml`,
`mqtt/Initialize-MqttAuth.ps1`, `mqtt/New-NativeConfig.ps1`,
`mqtt/verify-local-broker.cjs`,
`backend/test/telemetryContract.test.js` and ignored local credentials.
Modified: `mqtt/acl.example`, `mqtt/README.md`, `.gitignore`, both `.env.example`
files and `backend/src/services/telemetrySchema.js`.
Features: authenticated optional broker profile, device-specific publish ACLs,
short topic compatibility alongside existing building-qualified topics.
Commands/checks: `powershell -NoProfile -ExecutionPolicy Bypass -File
mqtt/Initialize-MqttAuth.ps1`, `powershell -NoProfile -ExecutionPolicy Bypass
-File mqtt/New-NativeConfig.ps1`, `node mqtt/verify-local-broker.cjs`.
Native Mosquitto 2.1.2 CLI publish/subscribe on temporary
loopback port 18886, QoS 1, invalid/anonymous login rejection, cross-device
publish rejection, forced disconnect and retained offline Last Will retrieval.
All five broker checks passed. `npm.cmd --prefix backend test`: 26 passed,
3 database-dependent tests skipped, 0 failed. The initial broker test waited
for buffered console output; using TCP readiness corrected the test harness.
Issues: Docker engine unavailable here, so the Compose profile is not runtime
verified. Physical ESP32 LAN connectivity is pending. No public listener or
firewall rule was created by these checks; existing demo broker config preserved.

Final review narrowed ACLs to exact channel paths: broad suffix wildcards would
overlap short and legacy topic depths. Repeated CLI tests confirm cross-device
denial at both depths. Compose `config --quiet` passed via the installed standalone
Compose plugin with an isolated Docker client config; mount targets and inherited
healthcheck were inspected without printing credentials. This is configuration
validation, not proof that the Docker broker ran.

### Phase 3 report

Created:

- `IoT/firmware/esp32_main/esp32_main.ino`
- `IoT/firmware/esp32_main/Settings.h`
- `IoT/firmware/esp32_main/config.example.h`
- `IoT/firmware/esp32_main/Sensors.h`
- `IoT/firmware/esp32_main/Sensors.cpp`
- `IoT/firmware/esp32_main/SafetySignals.h`
- `IoT/firmware/esp32_main/MqttTransport.h`
- `IoT/firmware/esp32_main/MqttTransport.cpp`
- `IoT/firmware/test/signal.test.cpp`
- `IoT/firmware/README.md`

Modified: `IoT/README.md`, this report,
`backend/src/services/telemetrySchema.js`, `backend/src/services/ingestV1.js`,
`backend/test/telemetryContract.test.js`. Final ACL/doc review is recorded above.

Implemented: modular sampling; configurable identities and short/legacy topics;
Wi-Fi backoff; native asynchronous ESP-MQTT QoS 1, reconnect, retained availability
and Last Will; SNTP UTC and unique message IDs; exact-field sensor health/nulls;
MPU6050 100 Hz target and one-second dynamic RMS aggregation; debounced SOS/SW420;
priority local SOS/flame buzzer task independent of networking; bounded offline
SOS queue, expiry diagnostics and private configuration template.

Minimal compatibility changes: null sensor values require explicit unhealthy
status and are excluded by the existing risk normalization. Availability now
preserves topic zone identity and does not erase a known building assignment
when the short topic cannot supply one. No database schema or risk-scoring
algorithm was changed; no second MQTT consumer or Express server was introduced.

Commands executed (repository root):

```powershell
$cli = "$env:LOCALAPPDATA\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"
$env:ARDUINO_DIRECTORIES_USER = Join-Path (Get-Location) '.docker-validation/arduino-user'
& $cli lib install 'DHT sensor library@1.4.6' 'Adafruit Unified Sensor@1.1.15'
& $cli compile --fqbn esp32:esp32:esp32 --build-path .docker-validation/esp32-build-v2 IoT/firmware/esp32_main
g++ -std=c++11 -Wall -Wextra -pedantic IoT/firmware/test/signal.test.cpp -o .docker-validation/signal-test.exe
& .docker-validation/signal-test.exe
$env:DASHBOARD_TEST_URI=''
$env:PIPELINE_TEST_URI=''
$env:PIPELINE_TEST_MQTT_URL=''
npm.cmd --prefix backend test
node mqtt/verify-local-broker.cjs
```

Actual results:

- Safe-default reference compile PASS: 371,708 bytes flash (28%);
  30,668 bytes global RAM (9%), ESP32 core 3.3.12.
- Additional isolated configured link-check PASS: 1,092,884 bytes flash (83%);
  51,516 bytes RAM (15%). The ignored fixture at
  `.docker-validation/configured-firmware/esp32_main` used obviously fake network
  credentials/reserved documentation IP and volatile **still-unassigned** pins
  to prevent optimization from discarding sensor/network paths. Its build command
  used `--build-path .docker-validation/esp32-configured-build` and that fixture
  sketch path. It was never uploaded and is not a wiring recommendation.
- Host C++ tests PASS: debounce, bouncing/held/repeated press handling, millis
  rollover, no-sample NaN, stationary gravity removal and known dynamic RMS.
- Backend final tests: **28 passed, 3 skipped, 0 failed** (31 total).
  New coverage checks topic compatibility/identity, required unhealthy null flags,
  exclusion of unavailable sensors from emergencies and building-ID preservation.
- Native MQTT CLI regression PASS after final ACL review. Authenticated Compose
  merged configuration PASS; Docker container execution not verified.
- Initial compile caught new header-name collisions with system `signal.h` and
  Arduino `Network.h`; renamed these new headers. The first configured fixture
  link attempt needed static linkage for its volatile test-only variables; fixed
  in the ignored fixture. Both final builds passed.

Remaining/unverified: exact board and module models, buzzer type, pin map,
electrical levels, calibration, upload/Serial results, sensor timing/accuracy,
physical Wi-Fi/MQTT reconnection, SOS-to-buzzer latency and actual device-to-Atlas
ingestion. No isolated MongoDB URI was supplied for the three integration tests;
they were skipped, not counted as passing. ESP32-CAM firmware/streaming is not
implemented in these phases. All example GPIOs remain -1 with pinsReviewed=false.
Upload and physical acceptance instructions are in `IoT/firmware/README.md`.

Scope preserved: no frontend, dashboard, routes, authentication, camera APIs,
sensor risk thresholds or existing simulator changes. Existing unrelated working
tree changes were left intact. No Phase 4 or later implementation was performed.
