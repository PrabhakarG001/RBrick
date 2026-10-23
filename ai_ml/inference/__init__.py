from typing import Protocol

try:
    from ..model_config import RuleConfig
    from ..schemas import PredictionInput, PredictionOutput
    from ..risk_engine import analyze
except (ImportError, ValueError):
    from model_config import RuleConfig
    from schemas import PredictionInput, PredictionOutput
    from risk_engine import analyze

from .model_interface import BaseModelInterface
from .model_loader import ModelLoader
from .anomaly_detector import StatisticalAnomalyDetector
from .multilabel_model import MultiLabelIoTModel

class Predictor(Protocol):
    def predict(self, reading: PredictionInput) -> PredictionOutput: ...

class RulesPredictor:
    def __init__(self, config: RuleConfig):
        self.config = config

    def predict(self, reading: PredictionInput) -> PredictionOutput:
        return analyze(reading, self.config)

__all__ = [
    "Predictor",
    "RulesPredictor",
    "BaseModelInterface",
    "ModelLoader",
    "StatisticalAnomalyDetector",
    "MultiLabelIoTModel"
]
