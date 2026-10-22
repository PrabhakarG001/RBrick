from datetime import datetime
from ..schemas import PredictionInput, DataQuality
from .validation import validate_telemetry_ranges
from .cleaning import clean_telemetry_batch
from .feature_builder import build_features

LIMITS = {"temperature": (-40, 80), "humidity": (0, 100),
          "mq2_raw": (0, 4095), "vibration_rms": (0, 16)}
DIGITAL = ("sw420", "pir", "flame", "sos")

def preprocess(reading: PredictionInput, now: datetime):
    values, invalid, missing, distrusted = {}, [], [], []
    for field, value in reading.sensors.model_dump().items():
        health = reading.health.get(field)
        if health and health != "ok":
            distrusted.append({"field": field, "health": health})
        elif value is None:
            missing.append(field)
        elif field in LIMITS and not LIMITS[field][0] <= value <= LIMITS[field][1]:
            invalid.append({"field": field, "reason": "out_of_range"})
        else:
            values[field] = value
    age = (now - reading.timestamp).total_seconds()
    stale = age > reading.stale_after_seconds or age < -300
    return values, DataQuality(invalid=invalid, missing=missing, distrusted=distrusted, stale=stale)

__all__ = [
    "preprocess",
    "LIMITS",
    "DIGITAL",
    "validate_telemetry_ranges",
    "clean_telemetry_batch",
    "build_features",
]
