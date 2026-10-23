# RBrick model artifacts

- `trained/iot_sensor_model.joblib`: the existing fitted RandomForestClassifier,
  restored byte-for-byte from this repository's original root artifact.
- `model_manifest.json`: verified origin, checksum, framework version and feature order.
- `artifacts/`: retained for compatibility with backend metadata paths; the existing
  Random Forest does not require a separate fitted transformer.

Use `python -m ai_ml.verify_assets` from the repository root after installing
`requirements-ml.lock.txt` alongside the service dependencies. The loader rejects
unrecognized artifacts before joblib deserialization. `ModelLoader` resolves the
package directory independently of the process working directory and reports
`loaded: true` only after the verified artifact actually loads.

The live `/predict` endpoint remains the rules engine. Model availability metadata
is separate from the active backend inference engine; see the main README.
