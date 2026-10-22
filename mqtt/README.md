# ResillioX MQTT layer

The existing demo `mosquitto.conf` is preserved. Compose publishes it on
loopback by default. Use the authenticated profile before enabling LAN access.
Do not expose this development listener to the public internet. MQTT on 1883
is plaintext: use only a trusted isolated LAN, or configure TLS separately.

## Windows authenticated setup

From the repository root, with Mosquitto installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File mqtt/Initialize-MqttAuth.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File mqtt/New-NativeConfig.ps1
& 'C:\Program Files\mosquitto\mosquitto.exe' -c mqtt/.secrets/mosquitto.native.conf -v
```

The initializer refuses to replace existing credentials. It creates ignored
`mqtt/.secrets/` files, using SHA512-PBKDF2 password hashes compatible with
Mosquitto 2.0+. Device passwords are in private `device-credentials.txt`.
Do not print, paste or commit these files. Each device uses its own account;
the backend account can read but cannot publish.

For physical devices, regenerate only the native config with
`-BindAddress <laptop-LAN-IPv4>` (or `0.0.0.0` on a trusted LAN). Connect ESP32
to that laptop IPv4, not localhost or the Docker service name. Permit the
broker port on the Windows private network only if required by your setup.

Alternatively, with Docker running:

```powershell
# Set MQTT_ENABLED=true in private .env; keep MQTT_TOPIC empty for both formats.
# Set MQTT_BIND_IP to the laptop LAN address only when ready for physical devices.
docker compose --env-file .env --env-file mqtt/.secrets/backend.env -f docker-compose.yml -f mqtt/compose.auth.yml up -d mosquitto backend
docker compose -f docker-compose.yml -f mqtt/compose.auth.yml logs --tail=50 mosquitto
```

The second env file supplies the backend's MQTT credentials; the broker uses
the hashed password file. The override preserves existing volumes and configures
an authenticated healthcheck through the Mosquitto client's default options file.
Run only one native/container broker on a given host port. Docker runtime checks
were unavailable in this session; native broker checks passed.

## Topics and reliability

| Topic | QoS | Retained |
|---|---|---|
| `building/{zone_id}/{device_id}/telemetry` | 1 | no |
| `building/{zone_id}/{device_id}/events` | 1 | never |
| `building/{zone_id}/{device_id}/status` | 1 | yes, JSON heartbeat |
| `building/{zone_id}/{device_id}/availability` | 1 | yes, plain online/offline + offline Last Will |
| `building/{zone_id}/{device_id}/camera/status` | 1 | no |

The existing `building/{building_id}/{zone_id}/{device_id}/...` topics remain
supported. Leave `MQTT_TOPIC` empty to subscribe to both sets; explicit custom
subscriptions must include whichever format your devices publish. Backend
`MQTT_PAYLOAD_FORMAT=resilliox-v1` uses the existing nested schema version
`"1.0"`, not a new parallel consumer. The legacy flat consumer remains opt-in.
Device/zone IDs must match payload IDs; building ID must also match on long
topics. Short topics still carry building_id in JSON. Use globally unique device
IDs: the existing database keys devices by deviceId, not building plus device.

Authoritative payload: `backend/src/services/telemetrySchema.js`, examples in
`IoT/README.md`. Simulator output uses `source: "simulation"`; real firmware
uses `source: "hardware"` and publishes only actual values. Firmware sends null
with exact-field unhealthy flags for unavailable sensors. Events are never
retained; QoS 1 can duplicate deliveries, handled by existing message_id indexes.
Availability is retained but does not itself carry a source field; treat it as
connection state, not a fresh safety measurement. Broker persistence does not
guarantee storage of device messages created while disconnected; firmware queues
are bounded and volatile. Existing backend acknowledges after persistence.

## CLI verification (Mosquitto 2.1 tools)

Repeat the isolated verified checks from the repository root:

```powershell
node mqtt/verify-local-broker.cjs
```

This uses a temporary loopback broker on port 18886, refuses an occupied port,
reads ignored local credentials and stops only its own child processes. Set
`MOSQUITTO_DIRECTORY` if the native tools are installed elsewhere. Test options,
configuration and persistence stay in ignored `.docker-validation/`.

Create private client options files under ignored `mqtt/.secrets/` with two lines
`-u <account>` and `-P <that-account-password>`. Credentials then stay out of
process command lines. For 2.0 clients use their per-user default config files.
Run the subscriber in one terminal and publisher in another:

```powershell
& 'C:\Program Files\mosquitto\mosquitto_sub.exe' -o mqtt/.secrets/backend.opts -h 127.0.0.1 -t 'building/zone01/esp32_main_01/telemetry' -q 1 -v
& 'C:\Program Files\mosquitto\mosquitto_pub.exe' -o mqtt/.secrets/device.opts -h 127.0.0.1 -t 'building/zone01/esp32_main_01/telemetry' -q 1 -m '{"source":"simulation","test":true}'
```

This transport-only test JSON is intentionally not a complete telemetry payload
and will be rejected by the backend. Use the existing simulator for valid test
telemetry. Test an incorrect password, anonymous login and cross-device publish:
these must be rejected. MQTT 5 publish denial may print `Not authorized` while
the CLI exits zero; inspect the broker response as well as the exit status.
A client declaring retained offline Last Will must publish offline after an
unclean disconnect; a new subscriber must receive that retained value.

Backend in Docker uses `mqtt://mosquitto:1883`; a host backend or simulator uses
`mqtt://127.0.0.1:1883`. ESP32 uses the laptop LAN IPv4 and individual device
credentials. Retry after broker startup is expected; container startup ordering
alone is not readiness.
