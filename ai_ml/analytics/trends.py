from typing import List, Dict

def analyze_trend(data_points: List[Dict]) -> Dict:
    """
    Analyzes historical readings series: detects trend slope (increasing, decreasing, stable).
    Points format: [{'time': ..., 'value': ...}]
    """
    if len(data_points) < 2:
        return {"direction": "stable", "slope": 0.0, "samples": len(data_points)}

    values = [p["value"] for p in data_points if p.get("value") is not None]
    if len(values) < 2:
        return {"direction": "stable", "slope": 0.0, "samples": len(values)}

    # Simple linear slope across indexes
    n = len(values)
    x = list(range(n))
    x_mean = sum(x) / n
    y_mean = sum(values) / n

    numerator = sum((x[i] - x_mean) * (values[i] - y_mean) for i in range(n))
    denominator = sum((x[i] - x_mean) ** 2 for i in range(n))

    slope = numerator / denominator if denominator != 0 else 0.0

    if slope > 0.05:
        direction = "increasing"
    elif slope < -0.05:
        direction = "decreasing"
    else:
        direction = "stable"

    return {
        "direction": direction,
        "slope": round(slope, 4),
        "samples": n,
        "first": values[0],
        "latest": values[-1],
        "delta": round(values[-1] - values[0], 2),
    }
