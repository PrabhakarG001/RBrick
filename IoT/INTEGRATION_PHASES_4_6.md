# ResillioX integration: Phases 4-6

This batch preserves the existing React frontend, Express server, MQTT consumers,
MongoDB models and Socket.IO event names. Python/FastAPI owns new risk inference;
the earlier JavaScript rules are a historical reference, not a fallback.

## Phase 4 report

Created: `backend/test/mqttV1.test.js`, `backend/scripts/verify-integration.js`,
and this report.
Modified: `backend/src/services/mqttServiceV1.js`,
`backend/src/services/ingestV1.js`.

Features: forced SUBACK on reconnect to avoid false failed readiness from cached
MQTT.js subscriptions; reconnect counter and connection timestamp; rejection of
retained emergency replay; device_status emission after successful database
updates; degraded sensor status no longer incorrectly means disconnected.

Commands: `node backend/scripts/verify-integration.js`,
`npm.cmd --prefix backend test` with database integration variables cleared.

Results: three Phase 4 tests passed, including actual native authenticated
Mosquitto -> existing MQTT.js subscriber -> simulated storage adapter, invalid
JSON rejection, device-status events and reconnect/resubscribe/delivery. The
storage adapter in this Phase 4 test is a test double, not MongoDB persistence.
Full baseline suite: 30 passed, 4 environment-gated skips, 0 failures.
Database failure test verifies no success acknowledgement/broadcast.

Remaining at Phase 4: Python service and real database pipeline verification are
next. Physical sensor connectivity remains unverified; no GPIO changes made.

## Phase 5 report

Created: `ai_ml/__init__.py`, `main.py`, `schemas.py`, `preprocessing.py`,
`feature_engineering.py`, `risk_engine.py`, `inference.py`, `model_config.py`,
`tests/test_risk.py`, `requirements.txt`, `requirements.lock.txt`, `.env.example`,
`README.md`. Modified: `.gitignore`, `backend/scripts/verify-integration.js` and
this report. Workspace-only virtual environment is ignored.

Features: strict Pydantic contracts, bounded input, optional service bearer token,
health/predict endpoints, sensor preprocessing/features, configurable Python rules,
0-100 scores, severity levels, explanations/incidents/version/source, explicit
missing/unhealthy/stale handling and a future predictor interface. No trained
model is claimed. Historical hazards do not create fresh live incidents.

Commands: installed Python 3.13.14 -> `-m venv .docker-validation/python-venv`;
workspace Python `-m pip install -r ai_ml/requirements.txt`,
`-m pytest ai_ml/tests -q`, `-m pip freeze` to tested lock file;
`node backend/scripts/verify-integration.js --phase=5`.

Results: 22 pytest cases passed. One upstream Starlette warning deprecates its
httpx test adapter; tests still pass with the pinned tested dependency set.
Actual temporary Uvicorn startup and HTTP health/normal/SOS/invalid-request
checks passed. No production database was used or hardware readings fabricated.
Remaining at Phase 5: Express-to-Python adapter, durable results/failure status,
full MongoDB/Socket.IO pipeline tests. Physical validation remains pending.

## Phase 6 report

Created:

- `backend/src/services/aiServiceClient.js`
- `backend/test/aiService.test.js`
- `ai_ml/Dockerfile`
- `ai_ml/.dockerignore`

Modified:

- `backend/src/services/ingestV1.js`
- `backend/src/services/mqttServiceV1.js`
- `backend/src/services/telemetrySchema.js`
- `backend/src/services/riskEngine.js` (historical-reference comment only)
- `backend/src/config/settings.js`
- `backend/src/models/index.js` (optional extensions to existing models)
- `backend/src/server.js`
- `backend/src/app.js`
- `backend/src/routes/systemRoutes.js`
- `backend/src/routes/iotRoutes.js`
- `backend/scripts/verify-integration.js`
- `backend/test/pipeline.test.js`
- `backend/test/mqttV1.test.js`
- `backend/test/telemetryContract.test.js`
- `.env.example`, `backend/.env.example`, `docker-compose.yml`
- `ai_ml/README.md`, `IoT/README.md`, this report

### Implemented behavior

- Existing validated v1 MQTT messages call Python /predict through a bounded,
  timeout-controlled HTTP client. Responses must match device/message/zone,
  timestamp/source, types, versions and stale/incident consistency.
- Python owns risk scoring, classification, hazard explanations, features and
  proposed incidents. Express adapts names to the existing dashboard contract.
  Production source has no import of the historical JavaScript risk engine.
- Successful telemetry, Python analysis, alerts and device updates commit in one
  MongoDB transaction using existing collections/models. Analysis records retain
  Python model/engine versions and features.
- Python timeout/unavailability/invalid response still permits valid telemetry
  storage with explicit unavailable-analysis status/error. No fabricated score,
  RiskAnalysis document, inferred alert or risk_update broadcast is created.
- Complete message IDs are idempotent. Unavailable-analysis IDs may retry on
  redelivery using the original durable payload, without changing stored sensor
  values or broadcasting altered duplicate data. There is no background replay
  worker; otherwise unavailable records stay unavailable.
- Cooldown deduplication queries committed alerts, avoiding process-local state
  that could incorrectly suppress an alert after a failed transaction/restart.
- MQTT acknowledges after storage. Database failure aborts the transaction,
  disconnects without successful acknowledgement and allows broker redelivery.
- Availability now carries the device_id expected by storage. Offline device
  state is respected by existing device/system/dashboard summary endpoints.
- Existing REST APIs and Socket.IO events are reused. Latest-reading responses
  do not attach an older risk result to an unanalysed reading; dashboard summary
  omits outdated risks while latest inference is unavailable. AI health/failure
  and MQTT reconnect details are exposed without URLs/tokens/raw error text.
- Compose adds an internal Python service with matching token/rule environment
  variables. No duplicate Express server, MQTT consumer, frontend change, Flask,
  SQLite or trained model was introduced.

### Commands and actual results

`node backend/scripts/verify-integration.js --phase=6` starts its own authenticated
Mosquitto 2.1.2, Uvicorn/Python 3.13.14 and MongoDB 8.2.1 replica set on loopback
ports 18887, 18001 and 27028, respectively. Credentials are freshly generated
test credentials; databases have random isolated test names and are dropped by
the tests. The private .env/Atlas URI was neither modified nor used by these tests.

Final executed result: **35 passed, 2 skipped, 0 failures** (37 backend tests).
The real Phase 6 integration case passed, not skipped. Python's earlier separate
suite passed **22 tests**. Actual Uvicorn HTTP health and normal/SOS/invalid input
checks passed again during the Phase 6 runner.

Verified in the actual local pipeline:

1. Valid simulated MQTT telemetry reaches the existing consumer and Python.
2. Invalid JSON/topic identity mismatches are rejected without storage.
3. Python NORMAL/CRITICAL results persist with source/version metadata.
4. Temperature/flame/SOS alerts are created; repeated conditions respect
   persisted cooldown, and duplicate telemetry/event IDs do not duplicate records.
5. Existing health/devices/readings/history/alerts/system and dashboard summary
   REST responses expose actual stored state.
6. sensor_update, risk_update, new_alert, device_status and sos_event arrive through
   the existing authenticated Socket.IO instance; simulated readings/risks/alerts
   retain their simulation source. Invalid socket tokens are rejected.
7. HTTP 503, timeout and malformed Python output persist telemetry explicitly
   without risk/alerts; recovery reuses one durable reading and stores one risk.
   Altered duplicate payload values do not replace or masquerade as stored data.
8. A deliberately injected risk-write error causes a real MongoDB transaction
   rollback: no reading or false success broadcast. Persistent-session broker
   redelivery after recovery creates exactly one reading and analysis.
9. Consumer reconnect/resubscribe and offline availability tracking work.
10. Client unit tests additionally reject oversized/incomplete/mismatched Python
    responses, unsafe URLs and invalid timeout configuration.

Compose validation command (installed standalone plugin):

```powershell
$env:DOCKER_CONFIG=Join-Path (Get-Location) '.docker-validation/docker-client'
& "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\cli-plugins\docker-compose.exe" -f docker-compose.yml -f mqtt/compose.auth.yml config --quiet
```

Merged configuration validation passed. Docker images/container runtime were not
tested; the running integration used the installed native tools. `git diff
--check` and JavaScript syntax checks passed for this batch.

### Test limitations and issues discovered

An initial attempt to enable every older database suite stalled in the existing
camera test's syntheticCamera helper: it waits for listening without calling
listen. That unrelated camera code/test was left unchanged. The Phase 6 runner
leaves both camera and dashboard database suites gated (2 explicit skips), while
executing real MongoDB persistence through the Phase 6 pipeline. Camera/API unit
tests still run. Old JavaScript rule-reference tests also remain regression tests,
not evidence that the production path still runs JavaScript inference.

Shared native broker fixtures initially interfered through their common simulator
ACL ID; files now run sequentially. The full test exposed a missing availability
device_id alias, corrected with regression assertions. Final tests passed after
these fixes. Failure injection in these tests is deliberate and clearly simulated.

Physical ESP32/ESP32-CAM connectivity, sensor calibration/timing, actual buzzer,
uploaded firmware, Atlas cloud deployment and Docker runtime remain unverified.
No GPIO assignments or physical claims were added. The existing React UI was not
edited or rebuilt. Its existing live risk cache may display historical results
until refresh; a dedicated unavailable-analysis presentation is future UI work.

## Readiness for Phase 7 (not implemented)

The simulated MQTT -> Python -> MongoDB -> REST/Socket.IO path is verified and
ready for the next explicitly requested integration phase. Hardware acceptance
still needs exact board/module/buzzer details and the Phase 3 physical checklist.
Future UI work can consume the new analysis-status/health fields without changing
the established backend event names. No Phase 7-10 work was performed.

Startup, configuration, failure semantics and repeatable native verification are
documented in `ai_ml/README.md`. Stopped after Phase 6.
