import os
import secrets
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from .inference import RulesPredictor
from .model_config import load_config
from .schemas import PredictionInput, PredictionOutput
from .services.analytics_service import AnalyticsService

analytics_service = AnalyticsService()

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.predictor = RulesPredictor(load_config())
    app.state.token = os.environ.get("AI_SERVICE_TOKEN", "")
    yield

app = FastAPI(title="ResillioX Python Risk Service", version="1.0.0", lifespan=lifespan)

@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError):
    # Do not echo raw telemetry or credentials through validation errors.
    return JSONResponse(status_code=422, content={"detail": "Invalid sensor telemetry"})

@app.middleware("http")
async def bounded_body(request: Request, call_next):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 16384:
            return JSONResponse(status_code=413, content={"detail": "Request too large"})
    request._body = bytes(body)
    return await call_next(request)

def authorize(request: Request, authorization: str = Header(default="")):
    token = request.app.state.token
    if token and not secrets.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")

@app.get("/health")
def health(request: Request):
    return {"status": "ok", "engine": "python-rule-based", "model_version": "python-rules-v1",
            "engine_version": "1.0.0", "trained_model": False}

@app.post("/predict", response_model=PredictionOutput, dependencies=[Depends(authorize)])
def predict(reading: PredictionInput, request: Request):
    return request.app.state.predictor.predict(reading)

@app.get("/analytics/model-info")
def model_info():
    return analytics_service.get_service_status()

@app.post("/analytics/anomalies", dependencies=[Depends(authorize)])
def detect_anomalies(payload: dict):
    readings = payload.get("readings", [])
    field = payload.get("field", "temperature")
    return {"field": field, "anomalies": analytics_service.process_historical_anomalies(readings, field)}
