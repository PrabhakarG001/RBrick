#!/usr/bin/env python3
"""RBrick MQTT sensor simulator.

Publishes synthetic ESP32-style telemetry to the RBrick Mosquitto broker so
the backend pipeline (MQTT -> risk engine -> MongoDB -> Socket.IO) can be
verified without physical hardware.

EVERY payload published by this script carries ``source: "simulation"`` so the
dashboard can label simulated data and operators can never mistake it for real
hardware measurements.

Topic convention (see mqtt/README.md):
    building/{building_id}/{zone_id}/{device_id}/telemetry
    building/{building_id}/{zone_id}/{device_id}/events      (never retained)
    building/{building_id}/{zone_id}/{device_id}/status      (retained)
    building/{building_id}/{zone_id}/{device_id}/availability (retained, LWT)

Examples:
    # 30 seconds of normal telemetry to the local compose broker:
    python IoT/simulator/publish_test_data.py --duration 30

    # One-shot emergency scenario (flame + SOS), no repeated emergencies:
    python IoT/simulator/publish_test_data.py --scenario emergency --once

    # Warning scenario at 5 s intervals to a remote broker with credentials:
    python MQTT_USERNAME=user MQTT_PASSWORD=pass \
        python IoT/simulator/publish_test_data.py \
        --host 192.168.1.10 --port 1883 \
        --building-id building01 --zone-id floor01_room101 \
        --device-id sim_node_01 --scenario warning --interval 5

Dependencies: paho-mqtt >= 2.0  (pip install paho-mqtt)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import signal
import sys
import time
import uuid
from datetime import datetime, timezone

try:
    import paho.mqtt.client as mqtt
except ImportError:  # pragma: no cover - environment guard
    print("paho-mqtt is required: pip install paho-mqtt", file=sys.stderr)
    sys.exit(2)

SCHEMA_VERSION = "1.0"
FIRMWARE_VERSION = "sim-1.0.0"
SOURCE = "simulation"  # Never claim hardware readings.

log = logging.getLogger("rbrick-simulator")

# Scenario definitions. Values are synthetic starting points only; they are
# not calibrated measurements of any real sensor.
SCENARIOS = {
    "normal": dict(temperature=(22.0, 28.0), humidity=(35.0, 65.0),
                   mq2_raw=(80, 350), vibration_rms=(0.01, 0.18),
                   sw420_prob=0, pir_prob=0, flame=False, sos=False),
    "warning": dict(temperature=(41.0, 55.0), humidity=(55.0, 80.0),
                    mq2_raw=(900, 1800), vibration_rms=(0.55, 1.4),
                    sw420_prob=0.45, pir_prob=0.35, flame=False, sos=False),
    "emergency": dict(temperature=(58.0, 78.0), humidity=(60.0, 90.0),
                      mq2_raw=(2200, 3600), vibration_rms=(1.6, 3.2),
                      sw420_prob=0.8, pir_prob=0.7, flame=True, sos=True),
}
# Isolate each demonstration so a single sensor's result can be inspected.
for name, overrides in {
    "temperature": {"temperature": (72, 74)},
    "mq2": {"mq2_raw": (2700, 2900)},
    "mpu6050": {"vibration_rms": (2.7, 3.0)},
    "sw420": {"sw420_prob": 1},
    "pir": {"pir_prob": 1},
    "flame": {"flame": True},
    "sos": {"sos": True},
    "missing": {"missing": True},
    "invalid": {"invalid": True},
    "offline": {}, "online": {},
}.items():
    SCENARIOS[name] = {**SCENARIOS["normal"], **overrides}
# After a single emergency event the simulator falls back to this scenario
# unless --repeat-emergency is given. Emergencies must not loop by default.
EMERGENCY_FALLBACK = "warning"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_telemetry(args: argparse.Namespace, scenario: dict) -> dict:
    """Build one nested rbrick-v1 telemetry payload."""
    sensors = {
        "temperature": round(random.uniform(*scenario["temperature"]), 1),
        "humidity": round(random.uniform(*scenario["humidity"]), 1),
        "mq2_raw": random.randint(*scenario["mq2_raw"]),
        "vibration_rms": round(random.uniform(*scenario["vibration_rms"]), 3),
        "sw420": random.random() < scenario["sw420_prob"],
        "pir": random.random() < scenario["pir_prob"],
        "flame": bool(scenario["flame"]),
        "sos": bool(scenario["sos"]),
    }
    health = {name: "ok" for name in sensors}
    if scenario.get("missing"):
        sensors["temperature"] = None
        health["temperature"] = "missing"
    if scenario.get("invalid"):
        sensors["temperature"] = "invalid-test-value"
    return {
        "schema_version": SCHEMA_VERSION,
        "message_id": str(uuid.uuid4()),
        "device_id": args.device_id,
        "building_id": args.building_id,
        "zone_id": args.zone_id,
        "timestamp": utc_now(),
        "source": SOURCE,
        "firmware_version": FIRMWARE_VERSION,
        "sensors": sensors,
        # Sensor health is reported per sensor; "ok" means the reading above
        # came from a working (simulated) sensor.
        "health": health,
    }


def build_event(args: argparse.Namespace, telemetry: dict, kind: str, detail: str) -> dict:
    """Emergency/event payload for the events channel (never retained)."""
    return {
        "schema_version": SCHEMA_VERSION,
        "message_id": str(uuid.uuid4()),
        "device_id": args.device_id,
        "building_id": args.building_id,
        "zone_id": args.zone_id,
        "timestamp": utc_now(),
        "source": SOURCE,
        "event": {"kind": kind, "detail": detail,
                  "referenced_message_id": telemetry["message_id"]},
    }


def build_status(args: argparse.Namespace, state: str) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "message_id": str(uuid.uuid4()),
        "device_id": args.device_id,
        "building_id": args.building_id,
        "zone_id": args.zone_id,
        "timestamp": utc_now(),
        "source": SOURCE,
        "firmware_version": FIRMWARE_VERSION,
        "state": state,
    }


class Simulator:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.stop = False
        self.published = 0
        self.emergency_sent = False
        self.topics = {
            "telemetry": f"building/{args.building_id}/{args.zone_id}/{args.device_id}/telemetry",
            "events": f"building/{args.building_id}/{args.zone_id}/{args.device_id}/events",
            "status": f"building/{args.building_id}/{args.zone_id}/{args.device_id}/status",
            "availability": f"building/{args.building_id}/{args.zone_id}/{args.device_id}/availability",
        }
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=args.client_id,
            protocol=mqtt.MQTTv311,
            clean_session=True,
        )
        if args.username:
            self.client.username_pw_set(args.username, args.password or None)
        # Last Will: broker marks the device offline if the connection drops.
        self.client.will_set(self.topics["availability"], payload="offline",
                             qos=1, retain=True)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

    # -- connection handling -------------------------------------------------
    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0 or str(reason_code) in ("Success", "0"):
            log.info("connected to broker %s:%s", self.args.host, self.args.port)
            client.publish(self.topics["availability"], "online", qos=1, retain=True)
            client.publish(self.topics["status"],
                           json.dumps(build_status(self.args, "online")), qos=1, retain=True)
        else:
            log.error("connection refused: %s", reason_code)

    def _on_disconnect(self, client, userdata, *args, **kwargs):
        log.warning("disconnected from broker (auto-reconnect: %s)", client.reconnect_delay_set is not None)

    # -- publishing ----------------------------------------------------------
    def publish_cycle(self, scenario_name: str) -> None:
        if scenario_name in ("offline", "online"):
            for channel, payload in (
                ("availability", scenario_name),
                ("status", json.dumps(build_status(self.args, scenario_name))),
            ):
                self.client.publish(self.topics[channel], payload, qos=1, retain=True).wait_for_publish(10)
            return
        scenario = SCENARIOS[scenario_name]
        telemetry = build_telemetry(self.args, scenario)
        info = self.client.publish(self.topics["telemetry"], json.dumps(telemetry), qos=1, retain=False)
        info.wait_for_publish(timeout=10)
        self.published += 1
        log.info("[%s] telemetry %s temp=%sC mq2=%s vib=%s sos=%s",
                 scenario_name, telemetry["message_id"][:8],
                 telemetry["sensors"]["temperature"], telemetry["sensors"]["mq2_raw"],
                 telemetry["sensors"]["vibration_rms"], telemetry["sensors"]["sos"])

        if telemetry["sensors"]["flame"] or telemetry["sensors"]["sos"]:
            if self.emergency_sent and not self.args.repeat_emergency:
                return
            kind = "sos" if telemetry["sensors"]["sos"] else "flame"
            event = build_event(self.args, telemetry, kind,
                                f"simulated {kind} condition (source=simulation)")
            einfo = self.client.publish(self.topics["events"], json.dumps(event), qos=1, retain=False)
            einfo.wait_for_publish(timeout=10)
            self.emergency_sent = True
            log.warning("[%s] emergency event %s published once (no repeat by default)",
                        scenario_name, event["message_id"][:8])

    def run(self) -> None:
        delay = self.args.reconnect_delay
        connect_deadline = time.monotonic() + 15
        while not self.stop:
            try:
                self.client.connect(self.args.host, self.args.port, keepalive=30)
                break
            except OSError as exc:
                if time.monotonic() >= connect_deadline:
                    raise ConnectionError("Broker connection deadline exceeded") from exc
                log.error("cannot reach broker %s:%s (%s); retrying in %ss",
                          self.args.host, self.args.port, exc, delay)
                time.sleep(delay)
        self.client.loop_start()
        # Wait for the connection thread to establish the session.
        deadline = time.time() + 15
        while not self.client.is_connected() and time.time() < deadline and not self.stop:
            time.sleep(0.1)
        if not self.client.is_connected():
            log.error("could not establish MQTT connection; shutting down")
            self.shutdown()
            sys.exit(1)

        scenario = self.args.scenario
        cycles = 0
        try:
            while not self.stop:
                self.publish_cycle(scenario)
                cycles += 1
                if self.args.once:
                    break
                if self.emergency_sent and not self.args.repeat_emergency:
                    log.info("falling back to '%s' scenario after single emergency", EMERGENCY_FALLBACK)
                    scenario = EMERGENCY_FALLBACK
                if self.args.duration and cycles * self.args.interval >= self.args.duration:
                    break
                # Sleep in small increments so Ctrl+C stops promptly.
                waited = 0.0
                while waited < self.args.interval and not self.stop:
                    time.sleep(0.1)
                    waited += 0.1
        except KeyboardInterrupt:
            pass
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        """Clean shutdown: publish offline state, then disconnect."""
        try:
            if self.client.is_connected():
                self.client.publish(self.topics["availability"], "offline", qos=1, retain=True).wait_for_publish(5)
                self.client.publish(self.topics["status"],
                                    json.dumps(build_status(self.args, "offline")),
                                    qos=1, retain=True).wait_for_publish(5)
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass
        self.client.loop_stop()
        self.client.disconnect()
        log.info("shutdown complete; %s telemetry messages published", self.published)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="RBrick MQTT sensor simulator (source=simulation)")
    parser.add_argument("--host", default=os.environ.get("MQTT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MQTT_PORT", "1883")))
    parser.add_argument("--username", default=os.environ.get("MQTT_USERNAME", ""))
    parser.add_argument("--password", default=os.environ.get("MQTT_PASSWORD", ""))
    parser.add_argument("--building-id", default="building01")
    parser.add_argument("--zone-id", default="floor01_room101")
    parser.add_argument("--device-id", default="sim_node_01")
    parser.add_argument("--client-id", default=None,
                        help="MQTT client ID (default: rbrick-sim-<random>)")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="normal")
    parser.add_argument("--interval", type=float, default=5.0,
                        help="Seconds between telemetry messages (default 5)")
    parser.add_argument("--duration", type=float, default=0,
                        help="Stop after N seconds (0 = run until Ctrl+C)")
    parser.add_argument("--once", action="store_true", help="Publish a single cycle and exit")
    parser.add_argument("--repeat-emergency", action="store_true",
                        help="Keep publishing emergencies (default: one emergency then warning)")
    parser.add_argument("--reconnect-delay", type=float, default=5.0)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    if args.client_id is None:
        args.client_id = f"rbrick-sim-{uuid.uuid4().hex[:8]}"
    if args.device_id == "" or "/" in args.device_id:
        parser.error("--device-id must be a non-empty topic-safe segment")
    for name in ("device_id", "building_id", "zone_id"):
        value = getattr(args, name)
        if not value or any(char in value for char in "/+#\x00"):
            parser.error(f"--{name.replace('_', '-')} must be a topic-safe segment")
    if args.interval <= 0 or args.reconnect_delay <= 0 or args.duration < 0:
        parser.error("interval/reconnect-delay must be positive; duration must be nonnegative")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    sim = Simulator(args)

    def handle_signal(signum, frame):  # noqa: ARG001
        log.info("signal %s received; stopping", signum)
        sim.stop = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    log.info("scenario=%s interval=%.1fs device=%s zone=%s (all data source=%s)",
             args.scenario, args.interval, args.device_id, args.zone_id, SOURCE)
    sim.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
