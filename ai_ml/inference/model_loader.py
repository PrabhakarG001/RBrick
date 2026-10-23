from pathlib import Path
from typing import Any, Dict
from .. import lesson1_ml


class ModelLoader:
    """Report actual verified loads; an arbitrary weight file is not a model."""

    def __init__(self, models_dir: str | Path | None = None):
        self.models_dir = Path(models_dir) if models_dir is not None else lesson1_ml.MODEL_PATHS[0].parent
        self.loaded_model = None
        self.model_metadata: Dict[str, Any] = {}

    def discover_and_load(self) -> Dict[str, Any]:
        self.loaded_model = None
        self.model_metadata = {
            "loaded": False,
            "engine": "python-statistical-rules",
            "version": "1.0.0",
            "future_model_ready": True,
            "supported_frameworks": ["ONNX", "PyTorch", "Scikit-Learn"],
            "status": "MODEL_NOT_AVAILABLE",
        }
        weights = sorted(p for p in self.models_dir.glob("*")
                         if p.is_file() and p.suffix.lower() in {".onnx", ".pt", ".pth", ".pkl", ".joblib", ".keras", ".h5"})
        if not weights:
            self.model_metadata["note"] = "No trained model weights found; using statistical rule engine."
            return self.model_metadata
        expected = lesson1_ml.MODEL_PATHS[0]
        if self.models_dir.resolve() != expected.parent.resolve() or not expected.is_file():
            self.model_metadata.update(status="MODEL_VERIFICATION_FAILED",
                                       note="Unconfigured model artifacts were not deserialized.")
            return self.model_metadata
        state = lesson1_ml.load_model_bundle()
        if not state["available"]:
            self.model_metadata.update(status=state.get("status", "MODEL_VERIFICATION_FAILED"),
                                       note=state.get("reason", "Model verification failed."))
            return self.model_metadata
        self.loaded_model = lesson1_ml._bundle_cache["model"]
        self.model_metadata.update(loaded=True, engine="custom-trained-model", version="custom-v1",
                                   filename=expected.name, status="VERIFIED")
        return self.model_metadata
