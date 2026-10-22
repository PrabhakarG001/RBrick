from abc import ABC, abstractmethod
from typing import Dict, Any

class BaseModelInterface(ABC):
    """
    Standard interface that any future custom trained model must implement.
    Allows seamlessly dropping in PyTorch, ONNX, or Scikit-learn models.
    """

    @abstractmethod
    def load(self, model_path: str, artifacts_path: str = None) -> bool:
        """Loads weights and preprocessors from disk."""
        pass

    @abstractmethod
    def predict_anomaly(self, feature_vector: Dict[str, float]) -> Dict[str, Any]:
        """
        Runs inference on feature vector.
        Returns: {
            'is_anomaly': bool,
            'confidence': float, # 0.0 - 1.0
            'anomaly_score': float, # unbounded or normalized
            'factor_attributions': dict
        }
        """
        pass

    @abstractmethod
    def get_metadata(self) -> Dict[str, Any]:
        """Returns model architecture, version, input dimensions, etc."""
        pass
