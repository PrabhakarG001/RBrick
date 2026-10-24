import os
import secrets
from contextlib import asynccontextmanager
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from .inference import RulesPredictor
from .inference.model_loader import ModelLoader
from .model_config import load_config
from .schemas import PredictionInput, PredictionOutput
from .services.analytics_service import AnalyticsService

analytics_service = AnalyticsService()

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.predictor = RulesPredictor(load_config())
    app.state.token = os.environ.get("AI_SERVICE_TOKEN", "")
    app.state.model_loader = ModelLoader()
    app.state.multilabel_model = app.state.model_loader.load_multilabel_model()
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

@app.get("/models/multilabel/info")
def multilabel_info(request: Request):
    model = getattr(request.app.state, "multilabel_model", None)
    if model is None or not getattr(model, "is_loaded", False):
        return {"loaded": False, "engine": "iot-building-safety-multilabel", "error": "Model artifact not loaded"}
    return model.get_metadata()

@app.post("/predict/multilabel", dependencies=[Depends(authorize)])
def predict_multilabel(payload: dict, request: Request):
    model = getattr(request.app.state, "multilabel_model", None)
    if model is None or not getattr(model, "is_loaded", False):
        raise HTTPException(status_code=503, detail="Multi-label model artifact not loaded")

    # Run multi-label inference using the loaded model interface
    try:
        result = model.predict_multi_label(payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failure: {str(e)}")

    # Format events dictionary with detailed probability and threshold metadata
    events_detail = {}
    for tgt in model.target_names:
        events_detail[tgt] = {
            "predicted": bool(result["predicted_labels"].get(tgt, 0) == 1),
            "probability": result["probabilities"].get(tgt, 0.0),
            "threshold": result["thresholds_used"].get(tgt, 0.50),
        }
    result["events"] = events_detail
    return result

@app.get("/analytics/model-info")
def model_info():
    return analytics_service.get_service_status()

@app.post("/analytics/anomalies", dependencies=[Depends(authorize)])
def detect_anomalies(payload: dict):
    readings = payload.get("readings", [])
    field = payload.get("field", "temperature")
    return {"field": field, "anomalies": analytics_service.process_historical_anomalies(readings, field)}
