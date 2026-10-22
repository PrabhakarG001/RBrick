"""Stateless Python rules, not a trained model or certified hazard detector."""
from datetime import datetime, timezone
from math import floor
from .schemas import PredictionInput, PredictionOutput, Hazard, Incident
from .model_config import RuleConfig
from .preprocessing import preprocess
from .feature_engineering import build_features

LEVELS = ["NORMAL", "LOW", "MODERATE", "HIGH", "CRITICAL"]

def analyze(reading: PredictionInput, rules: RuleConfig, now: datetime | None = None) -> PredictionOutput:
    now = now or datetime.now(timezone.utc)
    values, quality = preprocess(reading, now)
    features = build_features(values, rules)
    hazards, incidents = [], []

    def add(kind, factor, severity, contribution, message, value=None, threshold=None, informational=False, incident_kind="other"):
        hazards.append(Hazard(type=kind, factor=factor, severity=severity,
                              contribution=contribution, message=message, value=value,
                              threshold=threshold, informational=informational))
        if not informational and factor != "stale":
            incidents.append(Incident(incidentId=f"{reading.device_id}:{incident_kind}:{factor}",
                kind=incident_kind, field=factor, message=message, classification=severity, detectedAt=now))

    if values.get("sos") is True:
        add("SOS", "sos", "CRITICAL", rules.weights.sos,
            "SOS input active: emergency assistance requested.", True, incident_kind="sos")
    if values.get("flame") is True:
        add("POTENTIAL_FLAME", "flame", "CRITICAL", rules.weights.flame,
            "Potential flame indication; verify the sensor event and follow the site's safety procedure.", True, incident_kind="flame")

    for field, factor, kind, weight in [("temperature", "temperature", "ELEVATED_TEMPERATURE", rules.weights.temperature),
            ("mq2_raw", "mq2_raw", "GAS_SMOKE_INDICATOR", rules.weights.mq2_raw),
            ("vibration_rms", "vibration", "VIBRATION_INDICATOR", rules.weights.vibration)]:
        if field not in values:
            continue
        value, thresholds = values[field], getattr(rules, field)
        severity, multiplier, threshold = None, 0, None
        if value >= thresholds.critical:
            severity, multiplier, threshold = ("HIGH" if factor == "vibration" else "CRITICAL"), 1, thresholds.critical
        elif value >= thresholds.high:
            severity, multiplier, threshold = "HIGH", (0.7 if factor == "vibration" else 0.75), thresholds.high
        elif value >= thresholds.warning:
            severity, multiplier, threshold = ("LOW" if factor == "vibration" else "MODERATE"), (0.35 if factor == "vibration" else 0.4), thresholds.warning
        if severity:
            detail = "Raw MQ-2 is not gas concentration." if field == "mq2_raw" else "This does not confirm structural damage." if factor == "vibration" else "Validate thresholds for this installation."
            add(kind, factor, severity, floor(weight * multiplier + 0.5),
                f"{field} exceeds configured demonstration threshold {threshold}. {detail}", value, threshold,
                incident_kind="gas" if field == "mq2_raw" else "vibration" if factor == "vibration" else "other")

    if features.get("humidity_outside_band"):
        add("HUMIDITY_OUTSIDE_BAND", "humidity", "LOW", rules.weights.humidity,
            "Humidity is outside the configured demonstration environmental band.", values["humidity"])
    if values.get("sw420") is True:
        add("VIBRATION_SWITCH", "sw420", "LOW", rules.weights.sw420,
            "SW-420 vibration switch activated; inspect the local condition.", True, incident_kind="vibration")
    if values.get("pir") is True:
        add("MOTION", "pir", "LOW", rules.weights.pir,
            "PIR motion detected; motion alone does not establish intrusion.", True, informational=True)
    faults = len(quality.invalid) + len(quality.distrusted) + len(quality.missing)
    if faults:
        add("SENSOR_DATA_QUALITY", "fault", "LOW", rules.weights.fault,
            "One or more sensor readings are missing, invalid or unhealthy; excluded from hazard analysis.", faults, incident_kind="fault")
    if quality.stale:
        add("STALE_DATA", "stale", "LOW", 0,
            "Reading is stale or clock-skewed; this analysis describes historical data, not current safety.", True, informational=True)
    score = min(100, sum(h.contribution for h in hazards))
    severity = max(["NORMAL"] + [h.severity for h in hazards], key=LEVELS.index)
    for level in LEVELS[1:]:
        if score >= getattr(rules.bands, level) and LEVELS.index(level) > LEVELS.index(severity):
            severity = level
    # Historical hazards remain explainable but must not create fresh live alerts.
    if quality.stale:
        incidents = []
    return PredictionOutput(device_id=reading.device_id, message_id=reading.message_id,
        zone_id=reading.zone_id, source=reading.source, timestamp=reading.timestamp,
        risk_score=score, risk_level=severity, hazards=hazards, incidents=incidents,
        data_quality=quality, features=features, stale=quality.stale, analyzed_at=now,
        incident_cooldown_seconds=rules.incidentCooldownSeconds)
