"""Wire contracts reuse the firmware's resilliox-v1 names; no type coercion."""
from datetime import datetime
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .telemetry_schema import SensorTelemetrySchema
from .feature_schema import FeatureVectorSchema

Level = Literal["NORMAL", "LOW", "MODERATE", "HIGH", "CRITICAL"]
Source = Literal["hardware", "simulation"]
Health = Literal["ok", "missing", "error", "degraded"]
SensorName = Literal["temperature", "humidity", "mq2_raw", "vibration_rms", "sw420", "pir", "flame", "sos"]
Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_:.\-]+$")]

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

class Sensors(StrictModel):
    temperature: float | None = None
    humidity: float | None = None
    mq2_raw: float | None = None
    vibration_rms: float | None = None
    sw420: bool | None = None
    pir: bool | None = None
    flame: bool | None = None
    sos: bool | None = None

class PredictionInput(StrictModel):
    schema_version: Literal["1.0"] = "1.0"
    message_id: Identifier
    device_id: Identifier
    building_id: Identifier
    zone_id: Identifier
    timestamp: datetime = Field(strict=False)
    source: Source
    firmware_version: Annotated[str, Field(min_length=1, max_length=32)] | None = None
    sensors: Sensors
    health: dict[SensorName, Health] = Field(default_factory=dict)
    stale_after_seconds: int = Field(default=120, ge=10, le=86400)

    @field_validator("timestamp", mode="before")
    @classmethod
    def utc_timestamp(cls, value):
        if isinstance(value, str) and not value.endswith("Z"):
            raise ValueError("timestamp must end in Z")
        if not isinstance(value, (str, datetime)):
            raise ValueError("timestamp must be an ISO UTC datetime")
        return value

    @field_validator("timestamp")
    @classmethod
    def aware_timestamp(cls, value):
        if value.utcoffset() is None or value.utcoffset().total_seconds() != 0:
            raise ValueError("timestamp must be UTC")
        return value

class Hazard(StrictModel):
    type: str
    factor: str
    severity: Level
    contribution: int = Field(ge=0, le=100)
    message: str
    value: float | bool | None = None
    threshold: float | None = None
    informational: bool = False

class Incident(StrictModel):
    incidentId: str
    kind: Literal["sos", "flame", "gas", "vibration", "fault", "other"]
    field: str
    message: str
    classification: Level
    detectedAt: datetime
    recurrent: bool = False

class DataQuality(StrictModel):
    invalid: list[dict] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)
    distrusted: list[dict] = Field(default_factory=list)
    stale: bool

class PredictionOutput(StrictModel):
    device_id: Identifier
    message_id: Identifier
    zone_id: Identifier
    source: Source
    timestamp: datetime
    risk_score: int = Field(ge=0, le=100)
    risk_level: Level
    hazards: list[Hazard]
    incidents: list[Incident]
    data_quality: DataQuality
    features: dict[str, float | bool]
    stale: bool
    analyzed_at: datetime
    model_version: Literal["python-rules-v1"] = "python-rules-v1"
    engine_version: Literal["1.0.0"] = "1.0.0"
    incident_cooldown_seconds: int = Field(ge=0, le=86400)

__all__ = [
    "Level", "Source", "Health", "SensorName", "Identifier", "StrictModel", "Sensors",
    "PredictionInput", "Hazard", "Incident", "DataQuality", "PredictionOutput",
    "SensorTelemetrySchema", "FeatureVectorSchema"
]
