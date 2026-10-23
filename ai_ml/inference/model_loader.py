import os
from typing import Optional, Dict, Any
from .model_interface import BaseModelInterface

class ModelLoader:
    """
    Manages discovery and loading of future custom trained models.
    Operates safely in statistical fallback mode if model files are absent.
    """

    def __init__(self, models_dir: str = "models/trained"):
        self.models_dir = models_dir
        self.loaded_model: Optional[BaseModelInterface] = None
        self.model_metadata: Dict[str, Any] = {
            "loaded": False,
            "engine": "python-statistical-rules",
            "version": "1.0.0",
            "future_model_ready": True,
            "supported_frameworks": ["ONNX", "PyTorch", "Scikit-Learn"],
        }

    def discover_and_load(self) -> Dict[str, Any]:
        """
        Scans models_dir for valid weights (.onnx, .pt, .pkl).
        Returns current model status.
        """
        if not os.path.exists(self.models_dir):
            return self.model_metadata

        files = os.listdir(self.models_dir)
        weight_files = [f for f in files if f.endswith(('.onnx', '.pt', '.pth', '.pkl', '.joblib')) and not f.startswith('.')]

        if weight_files:
            # Custom model file discovered
            target_file = weight_files[0]
            self.model_metadata = {
                "loaded": True,
                "engine": "custom-trained-model",
                "filename": target_file,
                "version": "custom-v1",
                "future_model_ready": True,
            }
        else:
            self.model_metadata["loaded"] = False
            self.model_metadata["note"] = "No trained model weights found in models/trained/; using statistical rule engine."

        return self.model_metadata

    def load_multilabel_model(self, model_path: Optional[str] = None) -> Optional[BaseModelInterface]:
        """
        Loads the trained multi-label IoT building safety model artifact.
        Handles missing or invalid artifacts explicitly, setting appropriate fallback metadata.
        """
        from pathlib import Path
        from .multilabel_model import MultiLabelIoTModel, DEFAULT_MODEL_PATH
        target = Path(model_path) if model_path else DEFAULT_MODEL_PATH
        if not target.exists():
            self.loaded_model = None
            self.model_metadata = {
                "loaded": False,
                "engine": "iot-building-safety-multilabel",
                "error": f"Model artifact not found at {target}",
                "note": "Artifact missing; using statistical fallback.",
            }
            return None

        try:
            model = MultiLabelIoTModel(target)
            if model.is_loaded:
                self.loaded_model = model
                self.model_metadata = model.get_metadata()
                return model
            else:
                self.loaded_model = None
                self.model_metadata = {
                    "loaded": False,
                    "engine": "iot-building-safety-multilabel",
                    "error": f"Failed to load model artifact at {target}",
                    "note": "Artifact invalid; using statistical fallback.",
                }
                return None
        except Exception as exc:
            self.loaded_model = None
            self.model_metadata = {
                "loaded": False,
                "engine": "iot-building-safety-multilabel",
                "error": str(exc),
                "note": "Exception loading artifact; using statistical fallback.",
            }
            return None
