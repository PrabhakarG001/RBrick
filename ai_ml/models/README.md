# RBrick Trained Models Workspace

This directory is reserved for future custom trained AI/ML models, weights, and preprocessor artifacts.

## Directory Structure:
- `trained/`: Store trained weights (.onnx, .pt, .pth, .joblib, or .pkl).
- `artifacts/`: Store scalers, encoders, feature names lists, and metadata configs (.json, .yaml, .pkl).

## Model Loading:
The `model_loader.py` will inspect `trained/` for a designated model file. If not found or not configured, the system gracefully operates in statistical rule-based mode without interruption.
