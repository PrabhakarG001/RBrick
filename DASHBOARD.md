# ResillioX building safety dashboard

The existing dashboard shell, sidebar styles, background image, gradients, typography,
and card styles are retained. The primary navigation is now Overview, Monitoring,
Incidents, Maintenance, and Analytics.

## Routes and interactions

| Route | Purpose |
|---|---|
| `/dashboard` | Building overview, registered devices, active incidents, latest telemetry, maintenance due |
| `/monitoring` | Sensor readings, timestamps, historical charts, device filtering |
| `/monitoring?view=devices` | Register devices and edit names/building areas; view last maintenance |
| `/incidents` | Paginated incident filters, details, acknowledgement, resolution and JSON report export |
| `/incidents?view=history` | Incident lifecycle timestamps and paginated maintenance/fault history |
| `/maintenance` | Create/edit tasks, start/complete work, record service/fault events |
| `/analytics` | Stored sensor trends, incident counts by field/severity, door samples, maintenance completion and JSON export |
| `/settings` | Read-only sensor mapping/rule configuration |

Old `/upload`, `/analysis`, `/viewer`, `/report`, `/audit`, and `/safety` bookmarks
redirect into the corresponding building-safety experience. Landing dashboard buttons
and the footer open `/dashboard`.

## Connect real data

Keep credentials in the ignored root `.env`. Configure Atlas, the MQTT broker/topic,
an `IOT_API_TOKEN` of at least 32 characters, and the existing payload contract.
Enter the operator token in the dashboard connection panel. It stays in memory,
survives navigation inside the dashboard, and is cleared on disconnect or page reload.
The IoT operator token is separate from existing account authentication.

`SENSOR_DISPLAY_JSON` maps semantic UI names to existing payload fields. It does not
alter firmware payloads or MQTT topics. Numeric mappings: `temperature`, `humidity`,
`gas`, `smoke`. Boolean mappings: `waterLeak`, `doorOpen`, `sos`. Values must name
fields declared in `SENSOR_FIELDS_JSON`. Unmapped sensors are shown as unconfigured.

Example **only if these field names and types match your firmware**:

```dotenv
SENSOR_FIELDS_JSON={"temperature":"number","humidity":"number","gas":"number","leak":"boolean","door":"boolean","sos":"boolean"}
SENSOR_DISPLAY_JSON={"temperature":"temperature","humidity":"humidity","gas":"gas","waterLeak":"leak","doorOpen":"door","sos":"sos"}
DEVICE_OFFLINE_AFTER_SECONDS=120
```

Configure `ALERT_RULES_JSON` using actual hardware thresholds. Rules accept optional
`severity`: `info`, `warning`, or `critical`. Without explicit severity, SOS rules
use `critical` and other rules use `warning`; legacy incidents follow the same
documented convention. No gas, temperature, or humidity thresholds are invented.
The 120-second freshness default is configurable, not a guaranteed device heartbeat.

Device connectivity is inferred from recent received telemetry while MQTT is
subscribed. When MQTT is disabled/unavailable, connectivity is unknown. Older
readings are identified as stored/stale; an API failure retains a clearly labeled
snapshot. Missing readings are not replaced with sample values or safe statuses.
Door state alone does not establish authorized access. Sensor units remain the
firmware's raw units because the existing contract does not encode units.

## Persistent API additions

All `/api/iot/*` endpoints require the existing bearer token. `/status` reports safe
connection/configuration metadata even while the database is unavailable. No MQTT
credentials or database URI are exposed.

- Existing readings, devices, alerts and history lists now support validated
  pagination, counts and applicable filters.
- `POST /devices`, `PATCH /devices/:id`: registration and metadata editing.
- `PATCH /alerts/:id/acknowledge`, `PATCH /alerts/:id/resolve`: incident lifecycle.
- `GET/POST /tasks`, `PATCH /tasks/:id`: MongoDB-backed maintenance tasks.
- `GET /summary`, `GET /analytics`: actual counts, latest device readings and
  hourly/daily averages over up to 31 days.
- `POST /history`: record maintenance/fault events for registered devices.

Task due dates and completion timestamps are persistent. No assignees or account
permissions are fabricated. Device registration does not provision hardware.
Maintenance history is derived from completed tasks and recorded service events.
Repeated alert actions return a conflict instead of silently overwriting lifecycle
timestamps. User-provided values cannot introduce MongoDB query operators.

Overview latest telemetry is limited to 100 devices, labeled in the UI. Lists are
paginated in groups of 20. Incident exports explicitly describe their current
filtered-page coverage and total matching count. Analytics aggregates all matching
records within the selected time range; door history shows the latest 50 samples.
Leak incident counts use rule-triggered incidents, not repeated positive readings.
Historical uptime is unavailable because connection transitions were never recorded.

## Run and validate

```powershell
npm.cmd --prefix backend test
npm.cmd --prefix Frontend run dev
docker compose build frontend backend
docker compose up -d
```

The Vite proxy uses the existing backend on port 5000. `API_PROXY_TARGET` can override
that target for isolated local testing; production browser API requests remain
relative to `/api` and local public assets work through nginx's SPA fallback.

`backend/test/dashboard.test.js` additionally tests actual persistence when
`DASHBOARD_TEST_URI` points to a **separate local test MongoDB replica set**. It creates
and drops only a uniquely named `resilliox_dashboard_test_*` database. Never use a
production URI for that test. Existing tests still run without this environment
variable; the database integration test then reports skipped.

Validation performed for this migration used a separate loopback-only MongoDB and
MQTT broker, synthetic ESP32-style messages, and headless Edge. Browser tests cover
all five navigation items on desktop/mobile, device registration, incident filters,
acknowledgement/resolution, JSON download, maintenance creation/start/completion,
analytics filters, empty data, stale readings, and simulated service outages.

Actual building telemetry still requires a working Atlas connection, configured
MQTT service, payload/display mappings, hardware and alert rules. This migration
does not install firmware, add SMS/email delivery, predict hazards, or reconstruct
historical uptime. Configuration and team account invitations are not editable in
the browser because those administration APIs are not implemented.

The configured deployment reported Atlas `authentication_failed` and MQTT disabled
during verification. Correct the private database credentials/Atlas access and
configure the broker, firmware contract, display mappings, and rules before relying
on live building data. No private `.env` credentials were changed by this migration.
The profile screen is read-only until a profile-editing service is configured.

## Files changed for this migration

- Frontend routing/layout: `Frontend/src/App.jsx`,
  `Frontend/src/components/layout/DashboardLayout/DashboardLayout.jsx`,
  `Frontend/src/components/layout/Sidebar/Sidebar.jsx`.
- Workspace implementation: `Frontend/src/pages/Safety/SafetyContext.jsx`,
  `Frontend/src/pages/Safety/SafetyPages.jsx`, `Frontend/src/pages/Safety/safetyData.js`,
  `Frontend/src/pages/Safety/Safety.css`.
- Migrated page entry points: `Frontend/src/pages/Dashboard/Dashboard.jsx`,
  `Frontend/src/pages/Safety/Safety.jsx`, `Frontend/src/pages/Analytics/Analytics.jsx`,
  `Frontend/src/pages/Settings/Settings.jsx`, `Frontend/src/pages/Help/Help.jsx`,
  `Frontend/src/pages/Teams/Teams.jsx`, `Frontend/src/pages/Profile/Profile.jsx`.
- Compatibility redirects: `Frontend/src/pages/Upload/Upload.jsx`,
  `Frontend/src/pages/Analysis/Analysis.jsx`, `Frontend/src/pages/Viewer/Viewer.jsx`,
  `Frontend/src/pages/Report/Report.jsx`, `Frontend/src/pages/Audit/Audit.jsx`.
- Related integration: `Frontend/src/context/AuthContext.jsx` (guest copy only),
  `Frontend/src/pages/Landing/Landing.jsx` (dashboard destinations only),
  `Frontend/vite.config.js` (optional development API proxy target).
- Backend: `backend/src/app.js`, `backend/src/routes/iotRoutes.js`,
  `backend/src/models/index.js`, `backend/src/config/settings.js`,
  `backend/src/services/ingest.js`, `backend/test/dashboard.test.js`,
  `backend/package.json`.
- Deployment/docs: `.env.example`, `backend/.env.example`, `docker-compose.yml`,
  `DASHBOARD.md`.

Existing dashboard/layout/side-bar CSS and background assets were not modified.
No dependencies were added. Temporary browser scripts, screenshots, downloaded
reports, and test-service fixtures remain confined to ignored `.docker-validation`.
