from typing import Dict, Optional, Union
from pydantic import BaseModel, Field

class SensorTelemetrySchema(BaseModel):
    deviceId: str = Field(..., max_length=128)
    buildingId: Optional[str] = Field(default=None, max_length=128)
    floorId: Optional[str] = Field(default=None, max_length=128)
    zoneId: Optional[str] = Field(default=None, max_length=128)
    observedAt: str
    receivedAt: Optional[str] = None
    sensors: Dict[str, Union[float, int, bool]] = Field(default_factory=dict)
    health: Optional[Dict[str, str]] = None
    source: Optional[str] = "hardware"
