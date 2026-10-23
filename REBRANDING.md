# RBrick rebranding report

The rebranding inventory was saved before applying changes in `rebranding-inventory.json`.

## Changes

- Updated **146 original branding occurrences** across **62 existing files**, from an inventory of 158 occurrences in 63 files. Compatibility aliases and regression tests deliberately add some old-name strings; the final audit counts these separately.
- React: RBrick wordmark, browser title, building-safety description, landing/footer, login/legal copy, dashboard, support, profile defaults, downloads, package metadata and lockfile. Kept existing layout, shield logo and R favicon (neither asset spells an old name). No PWA manifest existed to update.
- Browser storage now uses `rbrick_token` and `rbrick_lang`. Existing token/language keys migrate on read. Sign-in and logout clear the legacy token keys so stale credentials cannot return after logout.
- Backend: RBrick package, default company/display labels, comments, test database prefixes and verification scripts. Existing API endpoints and stored data are unchanged.
- MQTT: `rbrick-v1` is the official configuration name; `resilliox-v1` remains an accepted alias for the identical schema. Public API metadata continues returning its existing legacy format identifier, and the frontend accepts either. Sensor wire fields, schema version, topics, ACLs and device IDs remain unchanged.
- AI/ML: service/API title, module documentation and model/dataset documentation use RBrick. Python imports and model behavior are unchanged.
- IoT: firmware boot label/header guards, simulator CLI description, logger and new simulator client-ID prefix use RBrick. Hardware configuration and telemetry are unchanged.
- Docker: application images use `rbrick-*`; stable Compose service names, network addresses and persistent volume keys remain unchanged. Third-party image names are unchanged.
- Fresh local database initialization defaults to `rbrick` with `rbrick_root` / `rbrick_app` identities. The initializer still refuses to overwrite existing secret directories. Existing database defaults/configuration and persisted accounts are preserved.

## Renamed files and folders

No source file/folder names contained old branding, so no host paths needed renaming. The workspace was already named RBrick.

The Mongo image paths were changed together with their callers:

- `/usr/local/bin/resilliox-mongo` to `/usr/local/bin/rbrick-mongo`
- `/docker-entrypoint-initdb.d/01-resilliox-app.js` to `/docker-entrypoint-initdb.d/01-rbrick-app.js`
- `/opt/resilliox/init-replica.js` to `/opt/rbrick/init-replica.js`
- `/data/configdb/resilliox-keyfile` to `/data/configdb/rbrick-keyfile` (copied from the same existing secret; key material is preserved)

The complete existing-file list is in `rebranding-changes.json`. New source files are the storage migration helper and its two frontend regression tests, plus one backend compatibility test.

## Verification

- Frontend production build: **passed**, 2,704 modules. Vite reports a bundle-size warning.
- Backend existing suite: **46 passed, 8 skipped, 0 failed**. Skipped tests require isolated MongoDB, MQTT and/or a running Python service configured through their test environment variables.
- Backend added MQTT compatibility test: **1 passed**.
- Frontend tests: **3 passed**, including migration, session precedence and logout regression checks.
- AI/ML: **32 passed**; one existing FastAPI/httpx deprecation warning.
- Native C++ firmware signal test: **passed**, including debounce, held-input suppression, rollover and MPU dynamic RMS aggregation.
- Base and combined local Docker Compose configurations: **passed** validation (the local check used synthetic URI/password placeholders). Docker reported a sandbox access warning for its user configuration file.
- ESP32 reference compile (`esp32:esp32:esp32`): **passed**, 371,708 bytes program storage (28%) and 30,668 bytes dynamic memory (9%). No physical devices were flashed or tested.
- Source audit: **214 text files inspected**; remaining legacy strings are itemized in `rebranding-audit.json`. Dependencies, generated builds, virtual environments, caches and archived `.docker-validation` artifacts were excluded from modification. Those historical/generated artifacts can retain old names.
- Existing `.env` was inspected for old-name counts only and was not changed. Ignored secret stores and private firmware configuration were not rewritten.

## Intentional old-name references

There are **27 occurrences in 13 source/config/test files**, all for compatibility or its tests:

- Existing MQTT subscriber identity in Compose/template: retained for persistent MQTT sessions.
- Existing actuator topic prefix: retained so currently connected devices continue receiving commands.
- Legacy MQTT format input and public API metadata identifier: supported alongside RBrick configuration.
- Legacy browser storage keys: read during migration and removed during sign-in/logout.
- Existing administrator login identity, password defaults and signing fallback: preserved to avoid changing account/session credentials as a branding side effect.

Private environment files and historical artifacts may also retain old identifiers. The inventory and this report intentionally mention former names as audit evidence. No live database contents were renamed or deleted.

## Manual steps

- Restart/rebuild services when ready to use the new application images. Keep existing volumes, credentials, device topics and `DB_NAME`; do not delete volumes to rebrand them.
- For a genuinely new local installation, `deployment/Initialize-Local.ps1` selects `rbrick` and writes its matching configuration. Existing installations should keep their current database selection unless a separate data migration is planned.
- Run the skipped external-service integration tests in a configured test environment. Physical device connectivity still requires hardware validation.
- This workspace has no `.git` directory or GitHub Actions directory. No Git repository was initialized and no remote was changed. A GitHub repository rename, if desired, must be performed separately in repository settings, followed by updating the actual remote and documentation links. No hosting rename is required for this source rebrand.
