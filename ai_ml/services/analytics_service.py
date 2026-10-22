from typing import List, Dict, Any
from ..preprocessing.validation import validate_telemetry_ranges
from ..preprocessing.feature_builder import build_features
from ..analytics.statistics import compute_series_stats
from ..analytics.trends import analyze_trend
from ..inference.model_loader import ModelLoader
from ..inference.anomaly_detector import StatisticalAnomalyDetector

class AnalyticsService:
    def __init__(self):
        self.model_loader = ModelLoader()
        self.anomaly_detector = StatisticalAnomalyDetector()

    def get_service_status(self) -> Dict[str, Any]:
        return self.model_loader.discover_and_load()

    def process_historical_anomalies(self, readings: List[Dict[str, Any]], field: str) -> List[Dict[str, Any]]:
        return self.anomaly_detector.detect_anomalies(readings, field)

    def compute_summary_analytics(self, series_data: List[float]) -> Dict[str, Any]:
        return compute_series_stats(series_data)
