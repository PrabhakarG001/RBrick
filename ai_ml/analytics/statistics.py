import math
from typing import List, Dict, Optional

def compute_series_stats(values: List[float]) -> Dict[str, Optional[float]]:
    """
    Computes count, mean, stddev, min, max, median for a numeric series.
    """
    clean_vals = [float(v) for v in values if v is not None and not math.isnan(v)]
    n = len(clean_vals)
    if n == 0:
        return {"count": 0, "mean": None, "std": None, "min": None, "max": None}

    mean_val = sum(clean_vals) / n
    variance = sum((x - mean_val) ** 2 for x in clean_vals) / (n if n == 1 else (n - 1))
    std_val = math.sqrt(variance)

    sorted_vals = sorted(clean_vals)
    median_val = sorted_vals[n // 2] if n % 2 != 0 else (sorted_vals[n // 2 - 1] + sorted_vals[n // 2]) / 2.0

    return {
        "count": n,
        "mean": round(mean_val, 2),
        "std": round(std_val, 2),
        "min": round(sorted_vals[0], 2),
        "max": round(sorted_vals[-1], 2),
        "median": round(median_val, 2),
    }

def calculate_zscore(value: float, mean: float, std: float) -> float:
    """
    Computes statistical Z-score with division by zero guard.
    """
    if std <= 1e-6:
        return 0.0
    return round((value - mean) / std, 2)
