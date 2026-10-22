def validate_telemetry_ranges(sensors: dict) -> dict:
    """
    Validates physical sensor limits and sanitizes invalid values.
    Returns cleaned sensors dictionary and validation notes.
    """
    cleaned = {}
    notes = []

    # Temperature: -40°C to 125°C
    if "temperature" in sensors:
        val = sensors["temperature"]
        if isinstance(val, (int, float)) and -40.0 <= val <= 125.0:
            cleaned["temperature"] = float(val)
        else:
            notes.append("temperature out of physical range")

    # Humidity: 0% to 100%
    if "humidity" in sensors:
        val = sensors["humidity"]
        if isinstance(val, (int, float)) and 0.0 <= val <= 100.0:
            cleaned["humidity"] = float(val)
        else:
            notes.append("humidity out of physical range")

    # Gas: 0 to 10000 ppm
    if "gas" in sensors:
        val = sensors["gas"]
        if isinstance(val, (int, float)) and 0.0 <= val <= 10000.0:
            cleaned["gas"] = float(val)
        else:
            notes.append("gas out of physical range")

    # Smoke: 0 to 10000 ppm
    if "smoke" in sensors:
        val = sensors["smoke"]
        if isinstance(val, (int, float)) and 0.0 <= val <= 10000.0:
            cleaned["smoke"] = float(val)

    # Vibration RMS: 0 to 50 g
    if "vibration_rms" in sensors:
        val = sensors["vibration_rms"]
        if isinstance(val, (int, float)) and 0.0 <= val <= 50.0:
            cleaned["vibration_rms"] = float(val)

    # Boolean sensors
    for b_sensor in ["flame", "water_leak", "door_open", "sos", "pir_motion", "sw420"]:
        if b_sensor in sensors:
            val = sensors[b_sensor]
            if isinstance(val, bool):
                cleaned[b_sensor] = val
            elif isinstance(val, (int, float)):
                cleaned[b_sensor] = bool(val)

    return {"cleaned": cleaned, "notes": notes, "valid": len(cleaned) > 0}
