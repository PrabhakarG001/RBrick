# ESP32 firmware: Phases 1-3

## Status and hardware gate

The Arduino workflow reuses installed ESP32 core 3.3.12. Reference FQBN
`esp32:esp32:esp32` means a generic classic ESP32 compile target, NOT a confirmed
physical board. ESP32-S2/S3/C3 and ESP32-CAM pinouts must not be inferred from it.
No hardware upload, wiring or sensor readings have been verified here.

Before wiring, provide the exact development board and ESP32-CAM model, module
labels/revisions, active/passive buzzer type, supply/output voltages and intended
pins. All example GPIOs are -1 and `pinsReviewed=false`. Firmware disables GPIOs
until reviewed. Do not simply set that flag to bypass the hardware review.
Existing water/door dashboard features are not fabricated as new hardware inputs:
Phase 3 implements only the supplied MPU6050/SW420/DHT22/MQ2/PIR/flame/SOS list.

## Files and configuration

`esp32_main/esp32_main.ino` starts sensors and the transport. `Sensors.cpp` owns
sampling/local alarm, `SafetySignals.h` owns debounce/RMS helpers and
`MqttTransport.cpp` owns Wi-Fi, clock and async ESP-MQTT. ESP-MQTT, cJSON, Wire,
WiFi and FreeRTOS are provided by the ESP32 core; no PubSubClient dependency is
added (the transport must publish actual QoS 1).

Copy `esp32_main/config.example.h` to ignored `esp32_main/config.local.h` and edit
only the private copy. Supply Wi-Fi SSID/password, LAN broker URI, per-device
MQTT credentials, building/zone/device IDs and eventually reviewed hardware pins.
Device ID should be globally unique and match the ACL username/device path.
`includeBuildingInTopic=false` emits the requested short topics. true emits the
existing building-qualified topics. No secrets are stored in tracked files.
For TLS use mqtts:// and the broker's PEM CA; certificate validation is required.
The example plaintext listener is for a trusted isolated LAN only.

Runtime pin checks reject duplicates, invalid pins, classic ESP32 flash pins
6-11, strapping pins 0/2/5/12/15, input-only pins used as outputs, incomplete I2C
pairs and unspecified buzzer type. MQ-2 uses ADC1 only with Wi-Fi. These checks
are conservative guards, not substitutes for the actual board schematic (PSRAM,
UART, USB and peripheral reservations vary by board).

## Build with existing Arduino CLI (Windows)

Run from the repository root. The workspace sketchbook and build output are
ignored. Dependencies are pinned, and no Node dependencies are added.

```powershell
$cli = "$env:LOCALAPPDATA\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"
$env:ARDUINO_DIRECTORIES_USER = Join-Path (Get-Location) '.docker-validation/arduino-user'
& $cli lib install 'DHT sensor library@1.4.6' 'Adafruit Unified Sensor@1.1.15'
& $cli compile --fqbn esp32:esp32:esp32 --build-path .docker-validation/esp32-build-final IoT/firmware/esp32_main
```

ESP32 core 3.3.12 was already installed. If setting up another computer, install
that version through the Arduino ESP32 board manager before compiling. This
reference build does not configure wiring or prove physical sensor operation.

After board confirmation, substitute its confirmed FQBN and actual COM port:

```powershell
& $cli board list
& $cli compile --fqbn '<confirmed-FQBN>' IoT/firmware/esp32_main
& $cli upload --fqbn '<confirmed-FQBN>' --port '<actual-COM-port>' IoT/firmware/esp32_main
& $cli monitor --port '<actual-COM-port>' --config baudrate=115200
```

Close Arduino Serial Monitor before upload. Rebuild after changing private
configuration. Keep credential-bearing firmware binaries private as well.

## Sampling and failure behavior

| Input | Implementation |
|---|---|
| MPU6050 | WHO_AM_I check; +/-2 g acceleration; 100 Hz target; 1-second window; square root of summed axis variances after removing per-axis DC/gravity; g units |
| DHT22 | Adafruit DHT 1.4.6, no faster than every 2 seconds; failed/out-of-range reads unhealthy |
| MQ-2 | 12-bit ADC1 raw value every 2 seconds after configurable 180-second minimum settling delay; never a calibrated gas concentration |
| SW420 | 5 ms input polling, 30 ms stable debounce, pulse held for one telemetry interval |
| PIR/flame | 5 ms digital polling, module active level configurable |
| SOS | 5 ms polling, 30 ms debounce, one event per press, held state visible in telemetry |
| Buzzer | separate priority-3 local task; active or passive mode only after type confirmed; SOS/flame activation, minimum 3-second hold |

MPU sampling is scheduled, not hard real-time: slow sensor/library activity can
reduce effective rate. Fewer than 50 samples per window or any I2C failure yields
null/error. Device bus reads retry automatically; DHT retries on the next sample.
A stationary board should yield near-zero dynamic RMS; validate scale/noise on
actual mounting before using the existing demonstration risk thresholds.

Local SOS/buzzer task has no network calls. Wi-Fi attempts use bounded 1-30 second
backoff, ESP-MQTT reconnects asynchronously every 5 seconds, and publishing uses
its bounded 16 KiB QoS 1 outbox. No network wait loop blocks local inputs. Validate
actual latency on the chosen board; this is not certified life-safety firmware.

Telemetry is sent every 2 seconds, status every 30 seconds. Availability online
and broker Last Will offline are retained. Telemetry/events are never retained.
A bounded 8-entry RAM SOS queue preserves recent presses while disconnected;
queued events older than 60 seconds are dropped with a Serial diagnostic. A
successful enqueue is not proof of backend storage. Reboot/power loss loses RAM
queues and SDK outbox expiry can drop unacknowledged messages. This is not a
persistent event recorder. SOS event timestamps use current synchronized UTC
minus elapsed press age, with second precision; no invented 1970 timestamps.

SNTP is required before timestamped publication (and TLS verification); an offline
LAN may need its own reachable NTP server in config. Local alarms continue without
SNTP, Wi-Fi, MQTT or backend. Secrets and full payloads are not logged to Serial.
Disabled/missing/failed/warming sensors publish null with exact-field health
flags. Digital health means configured input read, not proof that a disconnected
wire or failed module has been detected.

## Wiring review checklist (no GPIO assignment yet)

- Verify each breakout's supply requirements and logic levels. ESP32 GPIOs are
  not 5 V tolerant; MQ-2 modules and some digital breakouts may require level
  conversion/dividers. Verify actual output voltage before connecting an input.
- Verify I2C address, pullups to 3.3 V and module schematic. MPU6050 register setup
  targets the original device, not an unverified compatible substitute.
- Confirm DHT pullup, SW420 pulse width (shorter than debounce can be missed),
  PIR warmup, flame active level, SOS contact wiring/pullup and safe alarm test.
- Input-only GPIOs have no internal pullup: SOS needs an external pullup there.
  Confirm active levels; the example SOS assumes a switch to ground.
- Drive a buzzer through a suitable transistor/driver if its current requires it;
  do not assume it can be powered directly by a GPIO. Confirm active/passive type.
- MQ-2 heater power, stabilization and calibration require the actual module's
  documentation; the configurable delay is not proof of readiness or accuracy.

## Verification before claiming hardware completion

1. Confirm board/module models and review wiring/power with every pin unpowered.
2. Upload the confirmed board build; check Serial startup and configuration gate.
3. Subscribe using backend credentials. Check unique message IDs, UTC, source
   hardware, real sensor changes and null/unhealthy entries for disabled sensors.
4. Disconnect DHT/I2C safely; confirm null/error, then recovery after reconnect.
5. Press/bounce/hold/release SOS: one event per press, local buzzer active even
   with router/broker stopped. Confirm module polarity and alarm output timing.
6. Restart Wi-Fi/broker: observe reconnect, online availability and offline Last
   Will on unclean loss. Confirm no retained SOS replay and bounded-queue behavior.
7. Check stationary/moving MPU windows and measure actual sampling/alert latency.
8. Only then verify real ingestion through the existing backend and dashboard.

Host regression check (MinGW g++ if installed):

```powershell
g++ -std=c++11 -Wall -Wextra -pedantic IoT/firmware/test/signal.test.cpp -o .docker-validation/signal-test.exe
& .docker-validation/signal-test.exe
npm.cmd --prefix backend test
```

ESP32-CAM capture, streaming and board-specific firmware are not implemented in
these phases. Existing camera APIs are preserved; the camera topic/ACL is ready
for a separately confirmed device. No Phase 4+ work is included.

Implementation references: [Espressif ESP-MQTT API](https://docs.espressif.com/projects/esp-mqtt/en/latest/esp32/)
for the asynchronous QoS 1 outbox and [Arduino CLI compile documentation](https://arduino.github.io/arduino-cli/latest/commands/arduino-cli_compile/)
for the reference build workflow.
