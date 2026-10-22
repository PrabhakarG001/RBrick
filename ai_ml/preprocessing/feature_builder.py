from typing import Dict, Any

def build_features(sensors: Dict[str, Any]) -> Dict[str, float]:
    """
    Constructs normalized features and derived safety indicators.
    """
    features = {}
    temp = sensors.get("temperature")
    humidity = sensors.get("humidity")
    gas = sensors.get("gas")
    smoke = sensors.get("smoke")
    vibration = sensors.get("vibration_rms")

    if temp is not None:
        features["temperature_c"] = float(temp)
        features["temp_normalized"] = max(0.0, min(1.0, (float(temp) - 15.0) / 45.0))

    if humidity is not None:
        features["humidity_pct"] = float(humidity)
        features["humidity_normalized"] = max(0.0, min(1.0, float(humidity) / 100.0))

    # Heat Index Approximation if temp and humidity present
    if temp is not None and humidity is not None:
        t = float(temp)
        r = float(humidity)
        # Simplified Steadman formula
        features["heat_index"] = 0.5 * (t + 61.0 + ((t - 68.0) * 1.2) + (r * 0.094))

    if gas is not None:
        features["gas_raw"] = float(gas)
        features["gas_ratio"] = max(0.0, min(1.0, float(gas) / 1000.0))

    if smoke is not None:
        features["smoke_raw"] = float(smoke)

    if vibration is not None:
        features["vibration_rms"] = float(vibration)
        features["vibration_severity"] = max(0.0, min(1.0, float(vibration) / 2.0))

    return features
