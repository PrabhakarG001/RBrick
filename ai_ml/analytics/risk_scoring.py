from typing import Dict, List

def compute_zone_risk_ranking(zone_incidents: List[Dict]) -> List[Dict]:
    """
    Ranks zones or devices by incident volume, severity weights, and recurrent issues.
    zone_incidents: [{'zoneId': '...', 'critical': 2, 'warning': 5, 'info': 1}]
    """
    ranked = []
    for item in zone_incidents:
        crit = item.get("critical", 0)
        warn = item.get("warning", 0)
        info = item.get("info", 0)
        # Severity weights: critical=10, warning=3, info=1
        composite_score = (crit * 10) + (warn * 3) + (info * 1)

        level = "CRITICAL" if crit > 0 or composite_score >= 30 else \
                "HIGH" if composite_score >= 15 else \
                "MODERATE" if composite_score >= 5 else "LOW"

        ranked.append({
            "zoneId": item.get("zoneId", "unknown"),
            "criticalCount": crit,
            "warningCount": warn,
            "infoCount": info,
            "compositeScore": composite_score,
            "riskLevel": level,
        })

    ranked.sort(key=lambda x: x["compositeScore"], reverse=True)
    return ranked
