"""Lesson-1 ML integration for RBrick (refactored from iot_ml_lesson1.py).

Original file preserved verbatim as ``ai_ml/iot_ml_lesson1_original.py``.

ARCHITECTURAL CONTRACT (RBrick integration):
  * Canonical dataset: ``ai_ml/data/iot_sensor_data.csv`` (user-supplied; this
    module NEVER generates, overwrites or regenerates it).
  * No training or retraining happens at import time, at FastAPI startup, or
    from any service code path. ``train_model()`` exists only as an explicitly
    confirmed manual tool and is never called automatically.
  * Inference loads a compatible PRE-TRAINED bundle (``.joblib``) from
    ``ai_ml/models/trained/``. If none exists (or it is incompatible), every
    prediction request returns an honest ``MODEL_NOT_AVAILABLE`` status —
    simulated/fabricated predictions are forbidden.
  * SOS is intentionally excluded from the ML feature set (deterministic
    hardware interrupt; handled by the independent backend safety path).

Feature schema (seven inputs, exact names from the supplied implementation):
    temperature_c, humidity_pct, accel_magnitude_g, sw420_vibration,
    mq2_raw, motion_detected, flame_detected
Classification labels:
    NORMAL, GAS_SMOKE_EVENT, VIBRATION_EVENT, FIRE_SUSPECTED, MOTION_EVENT

NOTE: mq2_raw in this dataset is an illustrative 0-1023 scale (see the
original script's disclaimer). Physical firmware currently publishes 12-bit
ADC values (0-4095). Any hardware-to-model mapping must scale or retrain;
this module does not silently rescale.
"""

from __future__ import annotations

from pathlib import Path
import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

AI_DIR = Path(__file__).resolve().parent
DATASET_PATH = AI_DIR / "data" / "iot_sensor_data.csv"
# Preferred model location follows models/README.md; script-adjacent fallback
# matches where the original lesson script saved its bundle.
MODEL_PATHS = (
    AI_DIR / "models" / "trained" / "iot_sensor_model.joblib",
    AI_DIR / "iot_sensor_model.joblib",
)

FEATURE_COLUMNS: List[str] = [
    "temperature_c",
    "humidity_pct",
    "accel_magnitude_g",
    "sw420_vibration",
    "mq2_raw",
    "motion_detected",
    "flame_detected",
]
CLASS_LABELS: List[str] = [
    "NORMAL",
    "GAS_SMOKE_EVENT",
    "VIBRATION_EVENT",
    "FIRE_SUSPECTED",
    "MOTION_EVENT",
]
MODEL_NOT_AVAILABLE = "MODEL_NOT_AVAILABLE"
MODEL_VERIFICATION_FAILED = "MODEL_VERIFICATION_FAILED"

_bundle_cache: Optional[Dict[str, Any]] = None
_bundle_error: Optional[str] = None
_bundle_status = MODEL_NOT_AVAILABLE


def generate_synthetic_iot_data(samples_per_class: int = 250, random_seed: int = 42):
    """Preserved from the original lesson script — MANUAL USE ONLY.

    Disabled for all automated paths: importing this module, starting the
    backend, or any request handler must never create dataset files. The
    canonical CSV already exists and must not be overwritten.
    """
    raise RuntimeError(
        "Dataset generation is disabled in RBrick. The canonical dataset "
        f"ai_ml/data/iot_sensor_data.csv is user-supplied and must never be "
        f"regenerated or overwritten."
    )


def _find_model_file() -> Optional[Path]:
    for path in MODEL_PATHS:
        if path.is_file():
            return path
    return None


def _validate_bundle(bundle: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Return (validated_bundle, None) or (None, incompatibility_reason)."""
    if not isinstance(bundle, dict) or "model" not in bundle:
        return None, "bundle must be a dict containing a 'model' estimator"
    model = bundle["model"]
    if not (hasattr(model, "predict") and hasattr(model, "classes_")):
        return None, "bundled estimator lacks predict()/classes_ (not a fitted classifier)"
    names = bundle.get("feature_names")
    if list(names or []) != FEATURE_COLUMNS:
        return None, (
            "feature_names mismatch: model expects "
            f"{list(names or [])}, project schema is {FEATURE_COLUMNS}"
        )
    if getattr(model, "n_features_in_", None) != len(FEATURE_COLUMNS):
        return None, "estimator input dimension does not match feature schema"
    if list(getattr(model, "feature_names_in_", [])) != FEATURE_COLUMNS:
        return None, "estimator feature order does not match bundle metadata"
    classes = list(getattr(model, "classes_", bundle.get("classes", [])))
    unknown = [c for c in classes if c not in CLASS_LABELS]
    if unknown:
        return None, f"model classes {unknown} are not in the project label set {CLASS_LABELS}"
    return bundle, None


def load_model_bundle(force_reload: bool = False) -> Dict[str, Any]:
    """Load the compatible pre-trained bundle, if one exists.

    Never trains. Heavy imports (joblib) are lazy so the FastAPI service can
    import this module without ML dependencies installed.
    """
    global _bundle_cache, _bundle_error, _bundle_status
    if _bundle_cache is not None and not force_reload:
        return {"available": True, **_bundle_cache}
    if _bundle_error is not None and not force_reload:
        return {"available": False, "status": _bundle_status, "reason": _bundle_error}

    model_file = _find_model_file()
    if model_file is None:
        _bundle_status = MODEL_NOT_AVAILABLE
        _bundle_error = (
            "No pre-trained model file found (expected "
            f"{MODEL_PATHS[0]}). Training is disabled; place a compatible "
            ".joblib bundle trained with this project's feature schema."
        )
        return {"available": False, "status": MODEL_NOT_AVAILABLE, "reason": _bundle_error}

    # Joblib/pickle can execute code. Only deserialize the verified Git artifact.
    _bundle_status = MODEL_VERIFICATION_FAILED
    try:
        manifest = json.loads((AI_DIR / "models" / "model_manifest.json").read_text(encoding="utf-8"))
        expected_hash = manifest["sha256"]
        actual_hash = hashlib.sha256(model_file.read_bytes()).hexdigest()
    except (OSError, ValueError, KeyError):
        return {"available": False, "status": MODEL_VERIFICATION_FAILED,
                "reason": "Verified model provenance manifest is missing or invalid."}
    if actual_hash != expected_hash:
        return {"available": False, "status": MODEL_VERIFICATION_FAILED,
                "reason": "Model checksum does not match the verified project artifact."}

    try:
        import joblib  # lazy: only needed when a model file actually exists
    except ImportError as error:
        _bundle_error = f"joblib is not installed in this environment ({error})."
        return {"available": False, "status": _bundle_status, "reason": _bundle_error}

    try:
        raw = joblib.load(model_file)
    except Exception as error:  # unreadable/corrupt/incompatible pickle
        _bundle_error = f"Failed to load model file {model_file.name}: {type(error).__name__}."
        return {"available": False, "status": _bundle_status, "reason": _bundle_error}

    validated, reason = _validate_bundle(raw)
    if validated is None:
        _bundle_error = f"Incompatible model bundle at {model_file.name}: {reason}"
        return {"available": False, "status": _bundle_status, "reason": _bundle_error}

    _bundle_cache = {
        "model": validated["model"],
        "model_path": str(model_file),
        "classes": list(validated["model"].classes_),
    }
    _bundle_error = None
    return {
        "available": True,
        "model_path": str(model_file),
        "classes": _bundle_cache["classes"],
    }


def get_model_status() -> Dict[str, Any]:
    """Status report for /health and dashboards. No side effects."""
    state = load_model_bundle()
    return {
        "model_available": state["available"],
        "status": "READY" if state["available"] else state.get("status", MODEL_NOT_AVAILABLE),
        "feature_names": FEATURE_COLUMNS,
        "class_labels": CLASS_LABELS,
        "dataset_path": str(DATASET_PATH),
        "training_policy": "manual_only_never_automatic",
        "reason": state.get("reason"),
        "model_path": state.get("model_path"),
        "classes": state.get("classes"),
    }


def predict(features: Dict[str, Any]) -> Dict[str, Any]:
    """Classify one reading from the seven sensor features.

    Returns MODEL_NOT_AVAILABLE (never a fabricated label) when no compatible
    pre-trained model is loaded. ``event_label`` is deliberately not accepted:
    ground-truth labels exist only in the training CSV, never in live input.
    """
    if "event_label" in features:
        return {
            "status": "REJECTED",
            "message": "event_label is a ground-truth training column and must "
                       "never be supplied as a model input.",
        }

    missing = [name for name in FEATURE_COLUMNS if name not in features]
    if missing:
        return {"status": "REJECTED", "message": f"Missing features: {missing}"}

    state = load_model_bundle()
    if not state["available"]:
        return {
            "status": MODEL_NOT_AVAILABLE,
            "message": state.get("reason"),
            "prediction": None,
            "probabilities": None,
        }

    try:
        import pandas as pd
        row = pd.DataFrame([[float(features[name]) for name in FEATURE_COLUMNS]], columns=FEATURE_COLUMNS)
        model = _bundle_cache["model"]
        label = str(model.predict(row)[0])
        result: Dict[str, Any] = {
            "status": "OK",
            "prediction": label,
            "model_path": _bundle_cache["model_path"],
        }
        if hasattr(model, "predict_proba"):
            proba = model.predict_proba(row)[0]
            result["probabilities"] = {
                cls: round(float(p), 4) for cls, p in zip(model.classes_, proba)
            }
        return result
    except Exception as error:
        return {
            "status": "PREDICTION_FAILED",
            "message": f"{type(error).__name__} during inference.",
            "prediction": None,
        }


def train_model(*_args: Any, **_kwargs: Any) -> Dict[str, Any]:
    """Training is intentionally NOT provided in the integrated project.

    The original training workflow is preserved verbatim in
    ``ai_ml/iot_ml_lesson1_original.py`` for manual, offline use only.
    """
    return {
        "status": "TRAINING_DISABLED",
        "message": "RBrick never trains or retrains models automatically. "
                   "Run ai_ml/iot_ml_lesson1_original.py manually and offline if a "
                   "model is required, then place the .joblib in ai_ml/models/trained/.",
    }
