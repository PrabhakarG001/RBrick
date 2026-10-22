"""Features from available values only. No inferred/calibrated gas ppm."""
from .model_config import RuleConfig

def build_features(values: dict, rules: RuleConfig) -> dict:
    features = dict(values)
    if "temperature" in values:
        features["temperature_above_warning"] = values["temperature"] >= rules.temperature.warning
    if "humidity" in values:
        features["humidity_outside_band"] = not rules.humidity.low <= values["humidity"] <= rules.humidity.high
    if "mq2_raw" in values:
        features["mq2_above_warning"] = values["mq2_raw"] >= rules.mq2_raw.warning
    if "vibration_rms" in values:
        features["vibration_above_warning"] = values["vibration_rms"] >= rules.vibration_rms.warning
    return features
