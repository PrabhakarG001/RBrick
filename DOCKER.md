# ResillioX service startup and deployment

The existing React frontend, Express backend, Mosquitto broker and Python
FastAPI/Uvicorn engine are preserved. The optional local Compose override adds
an authenticated, persistent MongoDB replica set. Atlas remains supported by the
base configuration. Risk inference is Python-only (`python-rules-v1`); there is
no trained ML model or JavaScript prediction fallback.

## Complete local stack (five services)

Requirements: a working Docker Desktop Linux engine, sufficient free disk space,
and the existing native Mosquitto password tool for one-time MQTT setup. Container
execution was blocked in this session: Docker Desktop reported it was unable to
start. The merged configuration and native equivalent pipeline were tested;
container startup, image builds and restart persistence are not claimed verified.

From the repository root in PowerShell:

```powershell
if (!(Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
# Run once; existing secrets are deliberately never overwritten.
if (!(Test-Path -LiteralPath deployment/.secrets/local.env)) {
  powershell -NoProfile -ExecutionPolicy Bypass -File deployment/Initialize-Local.ps1
}
$composeArgs = @('--env-file','.env',
  '--env-file','deployment/.secrets/local.env',
  '--env-file','mqtt/.secrets/backend.env',
  '-f','docker-compose.yml','-f','docker-compose.local.yml')
docker info --format '{{.ServerVersion}}'
docker compose @composeArgs config --quiet
docker compose @composeArgs up -d --build --wait
docker compose @composeArgs ps
Invoke-RestMethod http://localhost:8088/api/health/ready
```

Open http://localhost:8088/dashboard. In the existing IoT connection form, enter
the private IOT_API_TOKEN from deployment/.secrets/local.env using your local
editor. Tokens remain in browser memory. Do not paste them into chat, commit them,
print resolved Compose configuration, or embed them in VITE_ variables.
The initializer was run for this workspace; rerunning it intentionally refuses
to overwrite existing credentials. The private root .env was preserved.

The local override explicitly chooses its own LOCAL_MONGODB_URI over an Atlas URI
in .env. It enables MQTT and reuses existing hashed MQTT credentials if present.
It generates separate random database root/application passwords, replica-set
keyfile, operator API token and Python-service token under ignored
`deployment/.secrets/`. MQTT credentials stay under ignored `mqtt/.secrets/`.
The app database user has readWrite for DB_NAME; Express does not use the root
account. Compose file secrets supply root/bootstrap credentials to MongoDB.

| Service | Internal address | Host exposure / persistence |
|---|---|---|
| React/nginx | frontend:80 | 127.0.0.1:8088 by default |
| Express | backend:5000 | no host port |
| MongoDB | mongo:27017 | no host port; mongo-data and mongo-config volumes |
| Mosquitto | mosquitto:1883 | 127.0.0.1:1883 by default; existing mosquitto-data volume |
| Python | ai_ml:8000 | no host port |

Single-member MongoDB rs0 supports the existing atomic transactions. The official
Mongo initialization creates users on a fresh data volume, then an authenticated,
idempotent healthcheck initializes/elects the replica-set primary. Keyfile copies
use MongoDB ownership and mode 400. Backend startup waits for MongoDB, MQTT and
Python health; its readiness checks database indexes, MQTT subscription, API token
and Python availability. Existing reconnect/retry logic handles startup delays.
Named volumes survive ordinary stop/start, restart and down without volume removal.
This is a local development configuration, not a high-availability replica set.

Local MongoDB explicitly uses MONGODB_TLS=false on the internal Docker network.
Atlas defaults to TLS=true, and SRV/Atlas TLS cannot be disabled. Do not use the
local non-TLS setting for an external production database. Public deployment
needs the appropriate TLS/network policy beyond this local configuration.

## Keep using Atlas instead

Set the existing private MONGODB_URI, DB_NAME, IOT_API_TOKEN and MQTT_ENABLED=true
in .env. Leave MONGODB_TLS=true. Do not include docker-compose.local.yml:

```powershell
docker compose --env-file .env --env-file mqtt/.secrets/backend.env -f docker-compose.yml -f mqtt/compose.auth.yml config --quiet
docker compose --env-file .env --env-file mqtt/.secrets/backend.env -f docker-compose.yml -f mqtt/compose.auth.yml up -d --build --wait
```

The existing base demo broker remains loopback-only and unchanged. Use the auth
override for device/network access. No existing volumes are renamed or deleted.
See ATLAS.md for cloud database account/network access setup; private cloud
credentials and live Atlas data were not used for this batch's tests.

## Python and browser networking

Express calls AI_SERVICE_URL=http://ai_ml:8000 in Compose with AI_TIMEOUT_MS=3000.
AI_SERVICE_TOKEN must match in Express and Python. The Python service owns
RISK_THRESHOLDS_JSON; defaults are demonstration rules requiring sensor validation.
No inference occurs in JavaScript. /health and /predict are internal Python APIs.

The browser uses same-origin /api and /socket.io, proxied by nginx to the existing
Express server. Service names such as backend, mongo and ai_ml are not browser
URLs. Existing WebSocket upgrade forwarding and reconnect/refetch are retained.
For a separate development browser origin, configure SOCKET_CORS_ORIGIN explicitly;
the normal same-origin path needs no permissive CORS configuration.

For native development, start the authenticated broker per mqtt/README.md, then
Python per ai_ml/README.md. A host backend uses AI_SERVICE_URL=http://127.0.0.1:8000
and MQTT_URL=mqtt://127.0.0.1:1883. Keep its private database settings appropriate
to the chosen database (Atlas requires TLS). Start the existing servers:

```powershell
$env:AI_SERVICE_URL='http://127.0.0.1:8000'
npm.cmd --prefix backend start
# In another terminal:
$env:API_PROXY_TARGET='http://127.0.0.1:5000'
$env:VITE_API_URL='/api'
npm.cmd --prefix Frontend run dev
```

No external inference, database or MQTT secrets belong in frontend variables.

## ESP32 / ESP32-CAM connection

Physical devices connect to the laptop's actual LAN IPv4 and published MQTT port,
not localhost, mongo, mosquitto or a Docker hostname. On a trusted private LAN set
MQTT_BIND_IP to that laptop IPv4 and recreate this stack's broker port mapping.
Do not expose anonymous MQTT or the database to the public internet. If Windows
Firewall needs a rule, restrict it to the relevant private network/interface.
Each device uses its own generated account and exact allowed topic paths.

Main firmware remains GPIO-gated until exact boards, modules, voltages and buzzer
type are confirmed. ESP32-CAM status uses the existing camera/status contract;
large images are fetched over HTTP by Express, never normal MQTT telemetry.
CAMERA_SNAPSHOT_URLS_JSON maps device IDs to private camera snapshot endpoints.
CAMERA_BEARER_TOKENS_JSON optionally provides per-camera server-side bearer tokens.
CAMERA_SOURCES_JSON can explicitly label a configured simulation endpoint;
otherwise source comes from the camera's MQTT status, or remains unknown.
Never classify a camera as physical merely because a URL responds. Camera status,
snapshots, incident association and maintenance were tested with simulation only.

## Ordinary restart and persistence checks

With Docker available, record a test device/incident and its IDs in the dashboard,
then restart only this stack and verify the same records remain:

```powershell
docker compose @composeArgs restart
docker compose @composeArgs ps
Invoke-RestMethod http://localhost:8088/api/health/ready
# Reload/reconnect the existing dashboard; confirm the recorded IDs still exist.
docker compose @composeArgs logs --tail=50 backend mosquitto ai_ml mongo
```

The ports, volumes and restart policies are configured; this container restart
procedure remains unexecuted because the engine could not start. Do not use
`down -v`, broad prune commands or delete secret files to troubleshoot an existing
volume. Mongo users are created only on initial data-volume setup: keep their
original secret files and use an intentional credential-rotation process later.

## Repeatable executed verification

```powershell
node --test Frontend/test/safetyData.test.js
node backend/scripts/verify-integration.js --phase=9
npm.cmd --prefix Frontend run build -- --outDir ../.docker-validation/frontend-phase9-build
& .docker-validation/python-venv/Scripts/python.exe -m pytest ai_ml/tests -q
```

The native runner starts isolated authenticated Mosquitto, Python and MongoDB,
uses random test databases, then tests actual React in headless Chrome at desktop
and mobile sizes. It verifies live telemetry, Python results, SOS, stale/offline,
reconnection, camera simulation, authorized snapshots, maintenance approval and
concurrent duplicate protection. Test databases are dropped; owned temporary
Mongo files are removed after its processes close. No production data is cleared.
Set INTEGRATION_PYTHON, INTEGRATION_MONGOD, MOSQUITTO_DIRECTORY or
INTEGRATION_BROWSER if installed tools are elsewhere.

See IoT/INTEGRATION_PHASES_7_9.md for exact results, changed files and limitations.
Phase 10 software simulation, restart results and repeatable demo commands are
documented in [IoT/INTEGRATION_PHASE_10.md](IoT/INTEGRATION_PHASE_10.md).
