"""Demonstration thresholds only. Validate/calibrate for each installation."""
import json
import os
from pydantic import Field, model_validator
from .schemas import StrictModel

class Threshold(StrictModel):
    warning: float
    high: float
    critical: float

    @model_validator(mode="after")
    def ordered(self):
        if not 0 <= self.warning < self.high < self.critical:
            raise ValueError("thresholds must be nonnegative and increasing")
        return self

class Weights(StrictModel):
    temperature: int = Field(default=25, ge=0, le=100)
    humidity: int = Field(default=5, ge=0, le=100)
    mq2_raw: int = Field(default=30, ge=0, le=100)
    vibration: int = Field(default=20, ge=0, le=100)
    flame: int = Field(default=30, ge=0, le=100)
    sos: int = Field(default=60, ge=0, le=100)
    sw420: int = Field(default=10, ge=0, le=100)
    pir: int = Field(default=5, ge=0, le=100)
    fault: int = Field(default=10, ge=0, le=100)

class Bands(StrictModel):
    LOW: int = Field(default=20, ge=1, le=100)
    MODERATE: int = Field(default=40, ge=1, le=100)
    HIGH: int = Field(default=65, ge=1, le=100)
    CRITICAL: int = Field(default=85, ge=1, le=100)

    @model_validator(mode="after")
    def ordered(self):
        if not self.LOW < self.MODERATE < self.HIGH < self.CRITICAL:
            raise ValueError("risk bands must increase")
        return self

class HumidityThreshold(StrictModel):
    low: float = Field(default=20, ge=0, le=100)
    high: float = Field(default=80, ge=0, le=100)

    @model_validator(mode="after")
    def ordered(self):
        if self.low >= self.high:
            raise ValueError("humidity bounds must increase")
        return self

class RuleConfig(StrictModel):
    temperature: Threshold = Field(default_factory=lambda: Threshold(warning=40, high=55, critical=70))
    mq2_raw: Threshold = Field(default_factory=lambda: Threshold(warning=700, high=1500, critical=2500))
    vibration_rms: Threshold = Field(default_factory=lambda: Threshold(warning=0.5, high=1.2, critical=2.5))
    humidity: HumidityThreshold = Field(default_factory=HumidityThreshold)
    weights: Weights = Field(default_factory=Weights)
    bands: Bands = Field(default_factory=Bands)
    incidentCooldownSeconds: int = Field(default=300, ge=0, le=86400)

def load_config() -> RuleConfig:
    # Service-owned configuration. Express cannot change risk rules per request.
    raw = json.loads(os.environ.get("RISK_THRESHOLDS_JSON", "{}"))
    defaults = RuleConfig().model_dump()
    if not isinstance(raw, dict):
        raise ValueError("RISK_THRESHOLDS_JSON must be an object")
    for key, value in raw.items():
        if key in defaults and isinstance(defaults[key], dict) and isinstance(value, dict):
            defaults[key].update(value)
        else:
            defaults[key] = value
    return RuleConfig.model_validate(defaults)
