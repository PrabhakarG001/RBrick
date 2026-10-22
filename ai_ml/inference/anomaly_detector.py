from typing import List, Dict, Any
from ..analytics.statistics import compute_series_stats, calculate_zscore

class StatisticalAnomalyDetector:
    """
    Detects statistical anomalies across streaming and historical sensor telemetry.
    Uses Z-score thresholding and interquartile range (IQR).
    """

    def __init__(self, zscore_threshold: float = 2.5):
        self.zscore_threshold = zscore_threshold

    def detect_anomalies(self, readings: List[Dict[str, Any]], field: str) -> List[Dict[str, Any]]:
        """
        Analyzes a series of readings for a specific numeric sensor field.
        Returns list of detected anomaly events with statistical explanations.
        """
        numeric_points = []
        for r in readings:
            val = r.get("sensors", {}).get(field)
            if val is not None and isinstance(val, (int, float)):
                numeric_points.append({
                    "deviceId": r.get("deviceId"),
                    "observedAt": r.get("observedAt"),
                    "value": float(val),
                })

        if len(numeric_points) < 5:
            return []

        values = [p["value"] for p in numeric_points]
        stats = compute_series_stats(values)
        mean_val = stats["mean"]
        std_val = stats["std"]

        if std_val is None or std_val == 0.0:
            return []

        anomalies = []
        for p in numeric_points:
            z = calculate_zscore(p["value"], mean_val, std_val)
            if abs(z) >= self.zscore_threshold:
                anomalies.append({
                    "deviceId": p["deviceId"],
                    "observedAt": p["observedAt"],
                    "field": field,
                    "value": p["value"],
                    "mean": mean_val,
                    "std": std_val,
                    "zscore": z,
                    "severity": "critical" if abs(z) >= 2.5 else "warning",
                    "explanation": f"Observed {field} value {p['value']} deviates significantly from baseline mean {mean_val} (Z-score: {z})",
                })

        return anomalies
