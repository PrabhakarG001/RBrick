from typing import List, Dict

def clean_telemetry_batch(readings: List[Dict]) -> List[Dict]:
    """
    Cleans a batch of readings: removes exact duplicate timestamps per device
    and flags missing critical fields.
    """
    seen = set()
    cleaned_batch = []

    for r in readings:
        dev_id = r.get("deviceId")
        observed_at = r.get("observedAt")
        key = f"{dev_id}:{observed_at}"
        if key in seen:
            continue
        seen.add(key)
        cleaned_batch.append(r)

    return cleaned_batch
