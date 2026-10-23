"""
ResillioX Multi-Label IoT Building Safety Model Inference Interface.

Provides multi-label event classification for 10 concurrent building safety hazards,
probabilities, per-event thresholding, device health extraction, and deterministic
hardware emergency override (SOS).
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Union
import joblib
import numpy as np
import pandas as pd

from .model_interface import BaseModelInterface
try:
    from ..schemas import PredictionInput
except (ImportError, ValueError):
    from schemas import PredictionInput

DEFAULT_MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "iot_building_safety_multilabel.joblib"


class MultiLabelIoTModel(BaseModelInterface):
    """
    Implements BaseModelInterface for the 10-label IoT building safety classifier.
    Predicts multiple simultaneous events, returns probabilities and per-event thresholds,
    and isolates the hardware SOS button into a deterministic emergency override.
    """

    def __init__(self, model_path: Optional[Union[str, Path]] = None):
        self.model_path = Path(model_path) if model_path else DEFAULT_MODEL_PATH
        self.bundle: Optional[Dict[str, Any]] = None
        self.pipeline: Any = None
        self.feature_names: List[str] = []
        self.target_names: List[str] = []
        self.decision_thresholds: Dict[str, float] = {}
        self.model_version: str = "unknown"
        self.disclaimer: str = ""
        self.is_loaded: bool = False

        if self.model_path.exists():
            self.load(str(self.model_path))

    def load(self, model_path: str, artifacts_path: Optional[str] = None) -> bool:
        """Loads the bundled trained model artifact and configuration."""
        target_path = Path(model_path)
        if not target_path.exists():
            self.is_loaded = False
            return False

        bundle = joblib.load(target_path)
        self.bundle = bundle
        self.pipeline = bundle.get("pipeline")
        self.feature_names = bundle.get("feature_names", [])
        self.target_names = bundle.get("target_names", [])
        self.decision_thresholds = bundle.get("decision_thresholds", {})
        self.model_version = bundle.get("model_version", "unknown")
        self.disclaimer = bundle.get("disclaimer", "")
        self.is_loaded = True
        return True

    def get_metadata(self) -> Dict[str, Any]:
        """Returns metadata about the loaded multi-label model."""
        if not self.is_loaded:
            return {
                "loaded": False,
                "engine": "iot-building-safety-multilabel",
                "version": "unloaded",
            }
        return {
            "loaded": True,
            "engine": "iot-building-safety-multilabel",
            "model_version": self.model_version,
            "feature_count": len(self.feature_names),
            "target_count": len(self.target_names),
            "target_names": self.target_names,
            "decision_thresholds": self.decision_thresholds,
            "split_counts": self.bundle.get("split_counts", {}),
            "disclaimer": self.disclaimer,
        }

    def predict_multi_label(
        self,
        input_data: Union[Dict[str, Any], pd.DataFrame, PredictionInput],
        override_thresholds: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """
        Runs multi-label inference.
        Returns:
          - predicted_labels: dict of binary 0/1 per target
          - probabilities: dict of probability float (0.0-1.0) per target
          - thresholds_used: dict of float decision thresholds
          - active_events: list of labels where predicted == 1
          - active_event_count: count of active ML events
          - emergency_override: True if hardware SOS button is pressed
          - sos_triggered: True if SOS button pressed
          - device_health: dict of telemetry health indicators
          - model_version: model version string
        """
        if not self.is_loaded or self.pipeline is None:
            raise RuntimeError("Model is not loaded. Ensure load() was called with a valid artifact path.")

        # Check SOS deterministic emergency override
        sos_pressed = self._check_sos(input_data)

        # Prepare feature DataFrame
        df_features = self._prepare_features(input_data)

        # Predict probabilities
        raw_probas = self.pipeline.predict_proba(df_features)

        # Format probabilities for the single row
        probas_dict = {}
        for i, tgt in enumerate(self.target_names):
            p = raw_probas[i]
            # p has shape (n_samples, 2) or (n_samples, 1)
            prob_pos = float(p[0, 1]) if p.shape[1] == 2 else float(p[0, 0])
            probas_dict[tgt] = round(prob_pos, 4)

        # Apply thresholds
        thresholds = dict(self.decision_thresholds)
        if override_thresholds:
            thresholds.update(override_thresholds)

        predicted_labels = {}
        active_events = []
        for tgt in self.target_names:
            th = thresholds.get(tgt, 0.50)
            is_active = int(probas_dict[tgt] >= th)
            predicted_labels[tgt] = is_active
            if is_active == 1:
                active_events.append(tgt)

        # Extract device health info if available
        device_health = self._extract_health(input_data)

        return {
            "predicted_labels": predicted_labels,
            "probabilities": probas_dict,
            "thresholds_used": thresholds,
            "active_events": active_events,
            "active_event_count": len(active_events),
            "emergency_override": sos_pressed,
            "sos_triggered": sos_pressed,
            "device_health": device_health,
            "model_version": self.model_version,
            "disclaimer": self.disclaimer,
        }

    def predict_anomaly(self, feature_vector: Dict[str, float]) -> Dict[str, Any]:
        """
        Implements BaseModelInterface.predict_anomaly for backward compatibility.
        """
        res = self.predict_multi_label(feature_vector)
        is_anomaly = bool(res["active_event_count"] > 0 or res["emergency_override"])
        max_conf = max(res["probabilities"].values()) if res["probabilities"] else 1.0

        factor_attributions = {
            k: v for k, v in res["probabilities"].items()
            if v >= res["thresholds_used"].get(k, 0.50)
        }
        if res["emergency_override"]:
            factor_attributions["emergency_sos_button"] = 1.0

        return {
            "is_anomaly": is_anomaly,
            "confidence": max_conf,
            "anomaly_score": float(sum(res["probabilities"].values())),
            "factor_attributions": factor_attributions,
            "active_events": res["active_events"],
            "emergency_override": res["emergency_override"],
        }

    def _check_sos(self, input_data: Union[Dict[str, Any], pd.DataFrame, PredictionInput]) -> bool:
        """Determines whether hardware SOS button is pressed (independent emergency override)."""
        if isinstance(input_data, PredictionInput):
            return bool(input_data.sensors.sos is True)
        if isinstance(input_data, pd.DataFrame):
            if "sos_button_pressed" in input_data.columns:
                return bool(input_data["sos_button_pressed"].iloc[0] == 1)
            if "event_sos_triggered" in input_data.columns:
                return bool(input_data["event_sos_triggered"].iloc[0] == 1)
            return False
        if isinstance(input_data, dict):
            if input_data.get("sos_button_pressed") in (1, True, "1"):
                return True
            if input_data.get("event_sos_triggered") in (1, True, "1"):
                return True
            sensors = input_data.get("sensors", {})
            if isinstance(sensors, dict) and sensors.get("sos") in (1, True, "1"):
                return True
        return False

    def _prepare_features(self, input_data: Union[Dict[str, Any], pd.DataFrame, PredictionInput]) -> pd.DataFrame:
        """Transforms input telemetry into an aligned DataFrame for model inference."""
        if isinstance(input_data, pd.DataFrame):
            # Extract available expected features
            row = {}
            for col in self.feature_names:
                row[col] = input_data[col].iloc[0] if col in input_data.columns else np.nan
            return pd.DataFrame([row])[self.feature_names]

        if isinstance(input_data, PredictionInput):
            # Adapt wire format PredictionInput
            sensors = input_data.sensors.model_dump()
            row = {
                "zone_id": str(input_data.zone_id) if input_data.zone_id else "UNKNOWN",
                "monitoring_role": "SECURITY_ZONE",
                "zone_restricted": 0,
                "is_after_hours": 0,
                "authorized_access_window": 1,
                "temperature_c": sensors.get("temperature"),
                "humidity_rh_pct": sensors.get("humidity"),
                "mq2_adc_raw_0_4095": sensors.get("mq2_raw"),
                "sw420_digital_state": int(sensors.get("sw420") is True),
                "pir_motion_detected": int(sensors.get("pir") is True),
                "flame_detected_normalized": int(sensors.get("flame") is True),
                "flame_adc_raw_0_4095": 100 if sensors.get("flame") else 3000,
            }
            # Fill missing required feature columns with np.nan (handled by pipeline SimpleImputer)
            for f in self.feature_names:
                if f not in row:
                    row[f] = np.nan
            return pd.DataFrame([row])[self.feature_names]

        if isinstance(input_data, dict):
            row = {}
            # Flatten sensors dict if present
            flat = dict(input_data)
            if "sensors" in flat and isinstance(flat["sensors"], dict):
                for k, v in flat["sensors"].items():
                    # Map legacy names if present
                    if k == "temperature":
                        flat["temperature_c"] = v
                    elif k == "humidity":
                        flat["humidity_rh_pct"] = v
                    elif k == "mq2_raw":
                        flat["mq2_adc_raw_0_4095"] = v
                    elif k == "sw420":
                        flat["sw420_digital_state"] = int(v is True)
                    elif k == "pir":
                        flat["pir_motion_detected"] = int(v is True)
                    elif k == "flame":
                        flat["flame_detected_normalized"] = int(v is True)
                    flat[k] = v

            for col in self.feature_names:
                row[col] = flat.get(col, np.nan)
            return pd.DataFrame([row])[self.feature_names]

        raise ValueError(f"Unsupported input type for multi-label inference: {type(input_data)}")

    def _extract_health(self, input_data: Union[Dict[str, Any], pd.DataFrame, PredictionInput]) -> Dict[str, Any]:
        """Extracts device and network health parameters."""
        health = {}
        if isinstance(input_data, PredictionInput):
            return {
                "source": input_data.source,
                "firmware_version": input_data.firmware_version,
                "health_status": input_data.health,
            }
        if isinstance(input_data, dict):
            for k in [
                "wifi_rssi_dbm",
                "packet_loss_pct",
                "mqtt_latency_ms",
                "sensor_read_fail_count",
                "sensor_values_stale_sec",
                "esp32_3v3_rail_v",
                "esp32_board_temp_c",
            ]:
                if k in input_data:
                    health[k] = input_data[k]
        elif isinstance(input_data, pd.DataFrame):
            for k in [
                "wifi_rssi_dbm",
                "packet_loss_pct",
                "mqtt_latency_ms",
                "sensor_read_fail_count",
                "sensor_values_stale_sec",
                "esp32_3v3_rail_v",
                "esp32_board_temp_c",
            ]:
                if k in input_data.columns:
                    health[k] = input_data[k].iloc[0]
        return health
