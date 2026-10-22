from typing import Dict, List, Optional
from pydantic import BaseModel, Field

class FeatureVectorSchema(BaseModel):
    deviceId: str
    timestamp: str
    features: Dict[str, float] = Field(default_factory=dict)
    flags: Dict[str, bool] = Field(default_factory=dict)
    missingSensors: List[str] = Field(default_factory=list)
    qualityScore: float = Field(default=1.0, ge=0.0, le=1.0)
