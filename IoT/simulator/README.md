# RBrick MQTT sensor simulator

Python simulator that publishes synthetic ESP32-style telemetry to the
RBrick Mosquitto broker. Every payload carries `"source": "simulation"`;
none of these values are real measurements.

Schema and topic contract: [`IoT/README.md`](../README.md) and
[`mqtt/README.md`](../../mqtt/README.md).

## Requirements

- Python 3.10+
- `python -m pip install -r IoT/simulator/requirements.txt` (paho-mqtt 2.1.0)
- A reachable Mosquitto broker (e.g. `docker compose up -d mosquitto`)

## Usage

```bash
# Normal telemetry, 5 s interval, run until Ctrl+C:
python IoT/simulator/publish_test_data.py

# Normal telemetry for 30 s to the compose broker:
python IoT/simulator/publish_test_data.py --duration 30

# Warning scenario (elevated temperature/MQ-2/vibration):
python IoT/simulator/publish_test_data.py --scenario warning --interval 5

# One-shot emergency (flame + SOS event); falls back to warning afterwards
# so emergencies never loop by default:
python IoT/simulator/publish_test_data.py --scenario emergency --once
python IoT/simulator/publish_test_data.py --scenario emergency --repeat-emergency  # opt-in looping

# Broker on another host with credentials (or set MQTT_HOST/MQTT_PORT/
# MQTT_USERNAME/MQTT_PASSWORD env vars):
python IoT/simulator/publish_test_data.py \
  --host 192.168.1.10 --port 1883 --username sim --password secret \
  --building-id building01 --zone-id floor01_room101 --device-id sim_node_01
```

| Option | Default | Meaning |
|---|---|---|
| `--host` / `--port` | `127.0.0.1` / `1883` | Broker address |
| `--username` / `--password` | none | Broker credentials |
| `--building-id` / `--zone-id` / `--device-id` | `building01` / `floor01_room101` / `sim_node_01` | Topic segments |
| `--scenario` | `normal` | `normal`, `warning`, `emergency`, `temperature`, `mq2`, `mpu6050`, `sw420`, `pir`, `flame`, `sos`, `missing`, `invalid`, `offline`, `online` |
| `--interval` | `5.0` | Seconds between telemetry messages |
| `--duration` | `0` (until Ctrl+C) | Stop after N seconds |
| `--once` | off | Publish a single cycle and exit |
| `--repeat-emergency` | off | Keep publishing emergencies (default: one, then warning) |
| `--client-id` | random | MQTT client ID |
| `--verbose` | off | Debug logging |

## Behavior notes

- Telemetry: QoS 1, not retained. Emergency events: QoS 1, **never retained**
  (an emergency must not be replayed after reconnect).
- Availability (`…/availability`): retained `online`/`offline` plus MQTT Last
  Will so the broker marks the device offline on unclean disconnect.
- Status (`…/status`): retained JSON heartbeat.
- Clean shutdown on Ctrl+C/SIGTERM publishes `offline` before disconnecting.
- Initial connection retries are bounded by a 15-second deadline plus the retry
  delay; refused authentication also exits non-zero. Use environment variables
  for passwords so they do not appear in command-line arguments.

## Phase 10 scenarios

All individual scenarios start from normal values, changing only the selected
sensor. `normal` never randomly triggers PIR/SW-420. Thresholds are demonstration
values, not calibration: temperature 72-74 C, MQ-2 2700-2900 raw counts,
MPU6050 dynamic vibration RMS 2.7-3.0 g. PIR alone is informational, not intrusion;
vibration does not establish structural damage.

`missing` publishes temperature null with exact-field health `missing`.
`invalid` deliberately publishes a string temperature to test safe rejection;
it must not enter stored readings. `offline`/`online` publish availability and
status only. Every clean exit publishes offline, so `--scenario online --once`
tests an online-to-offline transition; use continuous mode to observe it online.
An emergency, flame or SOS scenario falls back to warning after its first cycle
unless `--repeat-emergency` is explicitly supplied.

```powershell
python IoT/simulator/publish_test_data.py --scenario temperature --once
python IoT/simulator/publish_test_data.py --scenario mq2 --once
python IoT/simulator/publish_test_data.py --scenario mpu6050 --once
python IoT/simulator/publish_test_data.py --scenario missing --once
python IoT/simulator/publish_test_data.py --scenario invalid --once
python IoT/simulator/publish_test_data.py --scenario sos --duration 15
```

Repeatable full software demonstration and hardware checklist:
[`INTEGRATION_PHASE_10.md`](../INTEGRATION_PHASE_10.md).

## Verification (no hardware required)

Terminal 1 — subscriber:

```bash
docker compose exec mosquitto mosquitto_sub -h 127.0.0.1 -t 'building/#' -v
```

Terminal 2 — simulator:

```bash
python IoT/simulator/publish_test_data.py --duration 15 --scenario warning
```

You should see telemetry messages on
`building/building01/floor01_room101/sim_node_01/telemetry`, a retained
`online` availability message, and a retained `offline` message at shutdown.

End-to-end pipeline check (broker → backend → MongoDB → REST):

```bash
# backend running with MQTT_ENABLED=true, see ATLAS.md
python IoT/simulator/publish_test_data.py --duration 20
curl -H "Authorization: Bearer $IOT_API_TOKEN" \
  http://localhost:8088/api/iot/readings?deviceId=sim_node_01
```
