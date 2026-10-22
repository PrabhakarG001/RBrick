# MongoDB Atlas and JavaScript IoT backend

## What was found and what changed

The repository contains Ravynx: React 18/Vite 6 under `Frontend`, with document
verification pages, mock/demo data and a fetch client under `src/services/api.js`.
It had no backend, database models, ESP32 firmware, MQTT topics/payloads or alert
rules. There was no Flask implementation to migrate. Its existing document/auth
client contracts are preserved; they have no backend implementation in this repo.

New backend files:

- `backend/src/config/settings.js`: validated environment settings and payload contract.
- `backend/src/config/database.js`: Mongoose Atlas TLS connection with bounded selection timeout.
- `backend/src/models/index.js`: SensorReading, Alert, Device and MaintenanceEvent models/indexes.
- `backend/src/services/payload.js`: strict configured JSON validation and explicit alert rules.
- `backend/src/services/ingest.js`: transactional reading/alert/device persistence.
- `backend/src/services/mqttService.js`: one MQTT.js subscriber with serial persistence.
- `backend/src/middleware/auth.js`: operator bearer-token protection.
- `backend/src/routes/iotRoutes.js`, `app.js`, `server.js`: REST, health and process lifecycle.
- `backend/scripts/test-atlas.js`, `test-mqtt.js`: executable live integration checks.
- `backend/test/backend.test.js`: validation and HTTP failure-path tests.
- `backend/package.json`, `package-lock.json`, Dockerfile, `.dockerignore`, `.env.example`.

The frontend adds `/safety`, a link from the dashboard and a small API client
extension. Existing pages/styles/route behavior remain. The new page shows loading,
empty and error states and polls every ten seconds. It never displays invented
sensor values. Its manually entered operator token stays in memory only; use
localhost during development and HTTPS before sharing credentials over a LAN.

## Atlas dashboard setup

1. Sign in at https://cloud.mongodb.com. Choose your organization and existing
   project, or use the Projects menu to create a project named `Building Safety`.
2. In Project Overview/Database Deployments, select **Create**. Choose the
   **Free / M0** option if offered for that project; select an eligible provider
   and region near you, name the cluster, and create it. Do not select a paid
   tier to complete this setup. Atlas permits one Free cluster per project;
   only supported Free regions are shown. See the official
   [Free cluster procedure](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/).
3. In the security quickstart or **Database Access / Database Users**, add a
   dedicated password-authenticated database user such as `building_safety_app`.
   Choose a strong generated password and store it privately. Set the specific
   built-in role `readWrite` for database `building_safety`; restrict the user
   to this cluster where offered. Database users are separate from Atlas sign-in
   users. See [database users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/).
4. In **Network Access / IP Access List**, choose **Add IP Address**, then add
   your current public egress IPv4 as a `/32` entry. An expiring entry is suitable
   for the hackathon. Use the egress IP of the machine/network running Docker,
   not a private `192.168.x.x` device address. Update it when your hotspot/VPN
   changes. Avoid `0.0.0.0/0`. See
   [IP access lists](https://www.mongodb.com/docs/atlas/security/ip-access-list/).
5. On the cluster select **Connect > Drivers**, choose Node.js, and copy its
   `mongodb+srv://...` connection string. Replace username/password placeholders
   locally; percent-encode reserved characters in username/password. Include
   `/building_safety` before the query string, preserving Atlas-provided options.
   Example shape only:
   `mongodb+srv://<user>:<encoded-password>@<cluster-host>/building_safety?retryWrites=true&w=majority`.
   Follow the [Atlas connection instructions](https://www.mongodb.com/docs/atlas/connect-to-database-deployment/).
6. Store it as `MONGODB_URI` in the root ignored `.env`, and set
   `DB_NAME=building_safety`. Never add `VITE_MONGODB_URI`, include credentials
   in frontend code, or paste the URI/password into chat. Local scripts read
   `backend/.env` first, then root `.env`; process environment takes precedence.
7. Run the Atlas test below. It creates indexes and inserts/reads/deletes one
   UUID-tagged record in `connection_tests`. No sensor readings are fabricated.
   In Atlas Browse Collections, use `building_safety` to inspect later readings.

The application automatically creates indexes after connection. Readiness stays
false until this succeeds. Mongoose buffering is disabled, TLS remains enabled,
and database errors omit URI/error details to avoid exposing credentials.
See [Mongoose connection behavior](https://mongoosejs.com/docs/connections.html).

## Local configuration and commands (PowerShell)

```powershell
Set-Location 'C:\Users\Prabh\Downloads\ResilioX'
if (!(Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
notepad .env
# Generate a random API token locally; copy its output into IOT_API_TOKEN in .env.
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm.cmd install --prefix backend --no-audit --no-fund
npm.cmd --prefix backend test
npm.cmd --prefix backend run test:atlas
# Run locally (port 5000), or use Docker below; avoid competing subscribers.
npm.cmd --prefix backend start
```

For local frontend development, open a second PowerShell terminal at the repo
root. The existing Vite configuration now includes a development-only `/api`
proxy to the local Node server; set the existing public API-base hook:

```powershell
$env:VITE_API_URL='/api'
npm.cmd --prefix Frontend run dev
# Open http://localhost:5173/safety (or the port Vite reports).
# After stopping Vite with Ctrl+C:
Remove-Item Env:VITE_API_URL
```

The token must have at least 32 characters. Keep the generated value private.
Root `.env.example` describes all Compose settings. `backend/.env.example` is
provided for standalone backend use. Neither is a real credential file.
No Atlas credentials were available during implementation.

```powershell
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
docker compose logs --tail=100 backend frontend
docker compose exec backend npm run test:atlas
Invoke-RestMethod 'http://localhost:8088/api/health/live'
Invoke-RestMethod 'http://localhost:8088/api/health/ready'
Start-Process 'http://localhost:8088/safety'
```

`healthy` means the Node process/Nginx is serving. Readiness separately checks
Atlas, configured authentication, and MQTT subscription if enabled. The app may
run in a clearly degraded state before credentials are supplied. Atlas reconnects
and index setup are retried; no in-memory sensor database substitutes for Atlas.
The frontend reaches backend through `/api`, so same-origin requests need no CORS.
No backend port is published by Compose; use the frontend origin or `compose exec`.

## MQTT contract: configuration required

No actual firmware topic, sample payload, sensor units, thresholds or rules have
been supplied. Therefore `MQTT_ENABLED=false`, `MQTT_TOPIC`/`MQTT_URL` are empty,
`SENSOR_FIELDS_JSON={}` and `ALERT_RULES_JSON=[]`. There is no assumed temperature,
gas threshold, SOS field or payload. Configure the existing firmware contract
before enabling ingestion; malformed contracts fail startup instead of guessing.

Configuration accepts **flat JSON** messages:

- `DEVICE_ID_FIELD`: actual payload key for string device ID (default scaffold key `deviceId`).
- `EVENT_ID_FIELD`: optional reliable string event identifier key (scaffold `eventId`).
- `TIMESTAMP_FIELD`: optional ISO 8601 timestamp key including timezone (scaffold `timestamp`).
- `SENSOR_FIELDS_JSON`: mapping of actual sensor keys to `number` or `boolean`.
- `ALERT_RULES_JSON`: explicit rules with `field`, `operator`, `value`, `kind`, `message`.
  Operators: `gt`, `gte`, `lt`, `lte`, `eq`; booleans accept `eq` only.
  Kinds: `safety`, `sos`, `fault`. No rules means no generated alerts.

**Synthetic configuration example only, not an ESP32 contract or safety recommendation:**

```dotenv
DEVICE_ID_FIELD=board
EVENT_ID_FIELD=sequence
TIMESTAMP_FIELD=time
SENSOR_FIELDS_JSON='{"heat":"number","help":"boolean"}'
ALERT_RULES_JSON='[{"field":"help","operator":"eq","value":true,"kind":"sos","message":"Help requested"}]'
```

The corresponding illustrative JSON is
`{"board":"test-device","sequence":"test-001","heat":21,"help":false}`.
Do not change firmware to match these examples. Set mappings to its actual keys;
if firmware uses nested data, numeric flags, epoch timestamps or other types,
supply a real sample so the adapter can be changed deliberately. Unknown fields,
empty sensor data, stringified numbers and out-of-contract values are rejected.
Only provided sensor fields are stored. Missing timestamps use receive time;
units/ranges cannot be assumed without the real sensor contract. IDs allow
letters, digits, `_`, `:`, `.`, `-` and are limited to 128 characters.

Set `MQTT_URL`, credentials, `MQTT_TOPIC` and a stable, unique `MQTT_CLIENT_ID`
for this subscriber, then `MQTT_ENABLED=true`. Do not put credentials in the URL.
Use `mqtts://` for nonlocal transport; configure the actual broker trust chain
without disabling certificate verification. Topic wildcards are accepted for
subscription; the live publisher test requires a single concrete topic.

A separate existing Docker stack was observed with broker port 1884 mapped to
1883 on host loopback. It was left untouched and its credentials/ACLs are unknown.
If you intentionally use it, the new container can try
`mqtt://host.docker.internal:1884` with the actual broker credentials. Connectivity
is unverified: a loopback-only broker mapping may not be reachable from Docker
Desktop's host gateway, and is not reachable by ESP32 on another device.
Alternatively, use the real broker's reachable network address. If a broker is
subsequently added to this Compose project, use its service name, e.g.
`mqtt://mosquitto:1883`; no broker is created by this configuration.

The ESP32 uses the laptop's LAN/hotspot-reachable IPv4, actual published MQTT
port and dedicated broker credentials/ACLs. Never use `localhost` or Docker
service names on the ESP32. Verify hotspot client isolation and private-network
firewall routing from another client; do not expose an unauthenticated listener.

MQTT subscribes at QoS 1 with a persistent session and a stable client ID.
Persistence uses one Atlas transaction for reading, alerts and device last-seen.
QoS 1 acknowledgement follows successful persistence; database failure closes
the connection for broker redelivery. The broker must retain persistent sessions
and publishers must use QoS 1 for that guarantee. QoS 0 can lose readings during
outages. Valid events with `(deviceId,eventId)` are deduplicated using a partial
unique index; without an event ID, duplicates are possible. Invalid messages are
logged without contents and acknowledged/discarded to avoid poison-message loops.
See [MQTT.js backpressure API](https://github.com/mqttjs/MQTT.js#readme).

## REST contracts

All IoT routes require `Authorization: Bearer <IOT_API_TOKEN>`; this is a new
operator token, not an existing Ravynx login token. Missing server token returns
503; invalid supplied token returns 401. MongoDB failures return 503. Errors
never include connection strings. List responses are `{success:true,items:[...]}`.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/health/live` | Process liveness, no authentication |
| GET | `/api/health/ready` | Dependency readiness, 200 or 503 |
| GET | `/api/iot/readings` | Newest received readings with actual sensor map |
| GET | `/api/iot/alerts` | Persisted alerts, including SOS/fault rule events |
| PATCH | `/api/iot/alerts/:id/acknowledge` | Acknowledge an alert |
| GET | `/api/iot/devices` | Device identity and lastSeenAt; no invented online state |
| GET | `/api/iot/history` | Maintenance/fault history |
| POST | `/api/iot/history` | Record deviceId, kind (`maintenance`/`fault`), note and ISO occurredAt |

List filters: optional `deviceId`, `limit` (1–100, default 30), ISO `before`.
Readings use receivedAt for `before`, alerts createdAt, devices lastSeenAt and
history occurredAt. Stable sorting includes `_id`; timestamp-only pagination may
skip items sharing exactly the boundary timestamp. This is a bounded recent-data
API, not a full lossless export. Request bodies are limited to 16 KiB. There is
no public HTTP ingestion endpoint: readings arrive through configured MQTT.

Collections use indexed device/timestamp fields; readings also index receivedAt
and event IDs; devices have unique IDs. No TTL deletes sensor or maintenance
history. Retention policy and calibration/alert thresholds require your decision.

## Live pipeline checks

After configuring Atlas and the real MQTT contract, run exactly one subscriber
(local Node or Docker). Prepare a JSON file containing an actual valid firmware
payload from a dedicated test device with a fresh event identifier.

```powershell
# With Docker backend running; use the existing expected event schema.
docker compose cp .\sensor-test.json backend:/tmp/sensor-test.json
docker compose exec -e TEST_API_URL=http://localhost:5000 backend npm run test:mqtt -- /tmp/sensor-test.json
# Remove only the copied temporary payload after the check:
docker compose exec backend node -e "require('node:fs').unlinkSync('/tmp/sensor-test.json')"
```

The test publishes QoS 1 without retain, checks Atlas persistence and authenticated
API retrieval, and fails if the event already exists. It leaves that explicit test
event in history and may trigger your configured alert rules. Use a dedicated
test device/payload; do not send a false emergency from a real occupied building.
To run locally instead: `npm.cmd --prefix backend run test:mqtt -- .\sensor-test.json`
(the path is relative to backend when using `npm --prefix`).

Open `/safety`, enter your local IoT token and confirm the actual reading appears.
No browser or ESP32 is available to automate that final display/hardware check.
Review Node and broker logs, test real sensor transitions and verify the expected
stored alert. Wiring, power, Wi-Fi and calibration remain hardware-specific.

## Troubleshooting

| Failure | Check |
| --- | --- |
| Authentication failed | Use a database user, not Atlas web-login credentials; verify readWrite on DB_NAME; percent-encode URI credentials |
| Selection timeout / IP denial | Add current public egress `/32`; allow Atlas destinations/ports through the network; update access after hotspot/VPN changes |
| SRV lookup failure | Run `Resolve-DnsName -Type SRV _mongodb._tcp.<cluster-host>` using the actual host; check hotspot/Docker DNS and paused cluster |
| Certificate error | Check clock, CA trust and proxy interception; keep TLS validation enabled |
| Duplicate event ignored | Repeated `(deviceId,eventId)` is intentionally idempotent; use a fresh reliable event ID |
| Atlas test cannot create indexes | Check database role and index conflicts; inspect collections privately in Atlas |
| Backend live but not ready | Configure Atlas/token, then MQTT subscription if enabled; inspect sanitized backend logs |
| MQTT reconnects / no readings | Check broker URL, credentials, topic ACL, stable unique client ID, payload mapping and subscriber logs |
| MQTT payload rejected | Supply exact configured flat JSON fields, proper boolean/number types and ISO timestamps; message body is intentionally not logged |
| Token seems ignored | IoT page requires the IoT operator token; no token is embedded in JavaScript |
| Frontend CORS error in Vite | Launch with VITE_API_URL=/api so requests use the included dev proxy; restart Vite after changing environment values |

## Verification record — October 21, 2026

- PASS: backend npm dependency installation (128 packages), lockfile created.
- PASS: seven automated validation/HTTP/MQTT handler tests after correcting test
  discovery and explicit reserved-key validation. Handler tests simulate persistence
  and verify acknowledgement ordering/failure; they do not connect to a live broker.
- Atlas test executed and FAILED because `MONGODB_URI` is not configured; no live
  Atlas connection, insertion or read-back is claimed.
- PASS: Compose configuration validation; frontend and backend Docker image builds;
  Node dependency installation inside Linux; frontend build of 2,682 modules.
  Existing bundle-size warning remains.
- PASS: `docker compose up -d --wait`; both containers report healthy liveness.
  Only `127.0.0.1:8088` is published; backend port 5000 stays internal.
- PASS: Nginx configuration test and host HTTP smoke checks for `/`, `/dashboard`,
  `/safety`, Node liveness through the proxy, correct degraded readiness, fail-closed
  API access without token configuration, and served IoT JavaScript without Atlas
  URI configuration. HTML/asset checks do not prove browser rendering.
- Atlas test also executed inside the Node container and FAILED because
  `MONGODB_URI` is unset. No cloud connection or insertion is claimed.
- PASS: `git diff --check` (only Windows line-ending notices).
- NOT VERIFIED: real MQTT topic ingestion, transactional Atlas persistence,
  deduplication under redelivery, API reading retrieval from Atlas, actual browser
  rendering and ESP32-to-frontend flow. Credentials, firmware contract and hardware
  were not supplied. Unit tests use synthetic inputs, not fabricated live evidence.

### Subsequent credential configuration

The supplied connection details were saved only to the ignored root `.env`, with
reserved password characters percent-encoded and a local random IoT API token
generated. No credential values were added to tracked configuration or images.
The project's containers were recreated with these settings.

Both the Windows and container Atlas tests were executed again and failed.
DNS SRV lookup succeeded for all three members. Windows diagnostics reported
`MongooseServerSelectionError`, topology `ReplicaSetNoPrimary`, and TLS handshake
error `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR` for each member. This does not establish
that authentication succeeded. Readiness remains HTTP 503 with database unavailable,
authentication configured, and MQTT disabled. No insert/read-back succeeded.

Check the current public egress IP in Atlas's project IP Access List and permit
that `/32`, then check firewall/VPN/TLS interception if the handshake still fails.
Do not disable TLS validation. Rotate the password shared in chat and update
the private `.env`; then recreate the backend and rerun `test:atlas`.

### Latest connection retry

The private URI now includes the requested `compressors=zlib` option. Both host
and Docker connection tests were rerun. Atlas is now reachable, but host diagnostics
report `MongoServerError` code `8000` with an authentication rejection (raw error
and credentials omitted). The earlier TLS failure is not the current observed
blocker. No successful database connection, insert or retrieval is claimed.

Verify/reset the dedicated database user's password in Atlas and put the new
percent-encoded value into the ignored root `.env`. Angle brackets in example
URIs are placeholder delimiters and were omitted from the supplied password.
If they are actual password characters, they must instead be percent-encoded.
Keep Atlas-provided `authSource` options intact; this configuration uses the
Atlas database user's default authentication source and DB_NAME for application data.
Then run `docker compose up -d --force-recreate --wait` followed by
`docker compose exec backend npm run test:atlas`. Do not send the new password in chat.

### Terminal diagnostics update

Removed the unused `ravynx-root: file:..` backend dependency and rebuilt the
backend successfully with `npm ci` (127 packages). Eight automated tests pass,
including credential-redaction/error-classification coverage. The server and
Atlas test now report specific sanitized failure categories; repeated identical
connection errors are logged once while reconnect attempts continue.

The latest container Atlas test reports `[authentication_failed]`. Readiness is
HTTP 503 with `databaseError: authentication_failed`. This remains an external
database-user credential rejection; no successful Atlas read/write is claimed.
