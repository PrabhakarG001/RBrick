# AI/ML cleanup and verification

Cleanup is complete within ai_ml. The supplied dataset and the existing fitted model are intact. No training, dataset generation, model overwrite or hardware communication was performed.

## Folder cleanup

- Retained all 44 original non-cache files: runtime packages, preprocessing, feature definitions, dependency files, tests, Docker/environment templates, documentation and original training source.
- Removed 35 generated cache files in eight directories, plus the temporary dependency installation, integration runner, broker credentials/logs and isolated database created for verification.
- Moved no existing files. Restored the existing model unchanged from the original repository root artifact to its already-configured package location. The source artifact remains intact.
- Retained optional/future directories because backend model-status metadata and frontend documentation reference them; retained public Python exports and original training provenance rather than declaring them unused.
- Removed three unused imports from AnalyticsService.
- Fixed ModelLoader's working-directory-dependent discovery and false claim of a successful load based on file presence. It now delegates to the existing classifier loader and reports actual load results.
- Added checksum/provenance checks before deserialization, feature-order/dimension validation, reproducible ML dependency files, an asset verifier and four regression tests.

The pre-deletion per-file classification and reference inventory is in [cleanup-inventory.json](cleanup-inventory.json); removal and checksum results are in [cleanup-result.json](cleanup-result.json).

Removed cache directories:

- `ai_ml/.pytest_cache`
- `ai_ml/analytics/__pycache__`
- `ai_ml/inference/__pycache__`
- `ai_ml/preprocessing/__pycache__`
- `ai_ml/schemas/__pycache__`
- `ai_ml/services/__pycache__`
- `ai_ml/tests/__pycache__`
- `ai_ml/__pycache__`

## Dataset status: PRESENT / VERIFIED

- Path: `ai_ml/data/iot_sensor_data.csv`
- Rows: **1,250**; columns: **8** (seven features plus `event_label`).
- Exact feature order: `temperature_c, humidity_pct, accel_magnitude_g, sw420_vibration, mq2_raw, motion_detected, flame_detected`.
- Five supervised labels, 250 rows each: NORMAL, GAS_SMOKE_EVENT, VIBRATION_EVENT, FIRE_SUSPECTED, MOTION_EVENT.
- CSV is readable and nonempty; schema/order, finite numeric values, binary 0/1 fields, nonempty cells and label membership passed validation. No missing rows/values were found. No imputation or regeneration was needed.
- SHA-256 before/after: `f7d436bd76d08b565bcb4b7a435f07c6e88df2880acc3a6cb07dbfef1f344d58`.
- The original repository root CSV has identical contents after newline normalization. Its differing byte hash is solely CRLF versus LF; the existing canonical ai_ml CSV was preserved byte-for-byte.
- The preserved original training source describes synthetic demonstration data. This verification does not establish real-world sensor calibration or model accuracy.

## Model status: VERIFIED

- Actual path: `ai_ml/models/trained/iot_sensor_model.joblib`; size: **471,164 bytes**.
- Type: scikit-learn **RandomForestClassifier**, saved with scikit-learn **1.9.1**.
- Provenance: unchanged tracked file from PrabhakarG001/RBrick, original root `iot_sensor_model.joblib`, commit `4a7a2d7`, Git blob `9eaa44763c97af1ff4796c27623706c5a84d0d9e`. Confirmed against the local clone's Git history and clean tracked file before loading.
- SHA-256 before/after: `f1525f9a254ab2780af4cda1b66843e4893757874b1b007e055361cf9d022945`.
- Loaded successfully using matching dependencies after checking provenance/checksum. Both bundle metadata and estimator feature names/order/dimensions match the seven CSV features.
- The original training workflow fits directly on those columns; no separate saved scaler/encoder is required or missing.
- Prediction passed on one existing dataset row from each of five classes. All five results matched those row labels, with valid probability outputs. These smoke checks are not an independent holdout accuracy measurement.
- Model bytes were never serialized, overwritten or retrained. The original training-source hash is unchanged.
- Full sample outputs and dependency versions: [asset-verification.json](asset-verification.json).

## Integration status

**Existing rules inference and backend integration: WORKING (simulated software tests).** Real loopback Uvicorn, Mosquitto and an isolated MongoDB replica set were started. Existing tests verified sensor validation, real Python predictions, transactional persistence, authenticated REST, Socket.IO events, deduplication, AI timeout/failure behavior, rollback, reconnect and backend/consumer restart. The physical ESP32 and real installed sensors were not tested.

**Trained classifier inference: WORKING as the existing standalone lesson module, not connected to the live risk-score API.** Its class labels/probabilities do not match the backend's score/hazards/incidents response. It expects acceleration magnitude and illustrative 0-1023 MQ-2 values; the firmware supplies dynamic vibration RMS and 0-4095 raw ADC values. These are incompatible feature definitions/units, not a file-cleanup issue. No silent remapping or fabricated trained-model risk score was introduced. The rules API and its `trained_model: false` health declaration remain truthful and unchanged. A production trained-classifier integration requires an explicit sensor-feature mapping and response contract.

Dashboard output compatibility was verified at its existing REST/Socket.IO contract. No new browser visual or physical hardware test was run.

## Verification results

- Existing baseline: 32 AI/ML tests passed before these cleanup changes (preceding rebranding verification).
- Final AI/ML suite: **36 passed, 0 failed** with optional ML dependencies installed. Includes corrupt/untrusted-file rejection, real classifier/dataset checks and successful package-relative loading from another current directory.
- All **30 Python source files** parsed successfully, including the preserved training source; no training source entry point was executed.
- Dependency check: **no broken requirements**. Tested ML versions are pinned in `requirements-ml.lock.txt`; the rules-service lockfile is unchanged.
- Full existing backend suite with real services: **50 passed, 5 skipped, 0 failed**. The skipped camera/dashboard/security database suites are outside this phase's configured coverage. The first relocated wrapper hit its old cleanup-path assertion after these tests; it did not affect their results.
- Corrected, focused integration rerun: **7 passed, 0 failed, 0 skipped**; wrapper completed successfully and stopped its own services. Initial leftover test data and all temporary outputs were subsequently removed after checking resolved paths stay inside ai_ml.
- Final dataset/model/original-training-source hashes match the pre-cleanup inventory/provenance. No caches or temporary verification directories remain.
- One existing FastAPI/httpx deprecation warning remains.
- Git no-index comparison against the preserved main clone was reviewed. No repository was reinitialized, no remote was changed, and publication is handled separately after verification. All source edits are within ai_ml.

## Reproduce and remaining work

The temporary dependency installation was removed after successful tests. Install the recorded dependencies into your chosen Python environment before using the classifier:

```powershell
python -m pip install -r ai_ml/requirements.lock.txt -r ai_ml/requirements-ml.lock.txt
python -m ai_ml.verify_assets
python -m pytest ai_ml/tests -q -p no:cacheprovider
```

The existing lightweight Docker image intentionally retains its rules-service dependencies. Adding the classifier to the deployed live pipeline needs the feature/output mapping described above and those optional dependencies. The model and dataset are preserved, but this cleanup alone does not establish production calibration/readiness of the trained classifier.

Final statuses: **Dataset PRESENT; trained model VERIFIED; standalone classifier inference WORKING in the verification environment; existing backend rules integration WORKING; cleanup COMPLETE.** Trained classifier-to-dashboard integration is not implemented.

## Final directory tree

```text
ai_ml/
|-- analytics
|   |-- __init__.py
|   |-- risk_scoring.py
|   |-- statistics.py
|   `-- trends.py
|-- config
|   `-- model_config.example.yaml
|-- data
|   `-- iot_sensor_data.csv
|-- datasets
|   |-- processed
|   |   `-- .gitkeep
|   |-- raw
|   |   `-- .gitkeep
|   |-- samples
|   |   `-- README.md
|   `-- README.md
|-- inference
|   |-- __init__.py
|   |-- anomaly_detector.py
|   |-- model_interface.py
|   `-- model_loader.py
|-- models
|   |-- artifacts
|   |   `-- .gitkeep
|   |-- trained
|   |   |-- .gitkeep
|   |   `-- iot_sensor_model.joblib
|   |-- model_manifest.json
|   `-- README.md
|-- preprocessing
|   |-- __init__.py
|   |-- cleaning.py
|   |-- feature_builder.py
|   `-- validation.py
|-- schemas
|   |-- __init__.py
|   |-- feature_schema.py
|   `-- telemetry_schema.py
|-- services
|   |-- __init__.py
|   `-- analytics_service.py
|-- tests
|   |-- test_analytics.py
|   |-- test_assets.py
|   |-- test_inference.py
|   |-- test_preprocessing.py
|   `-- test_risk.py
|-- __init__.py
|-- .dockerignore
|-- .env.example
|-- .gitignore
|-- asset-verification.json
|-- CLEANUP_REPORT.md
|-- cleanup-inventory.json
|-- cleanup-result.json
|-- Dockerfile
|-- feature_engineering.py
|-- iot_ml_lesson1_original.py
|-- lesson1_ml.py
|-- main.py
|-- model_config.py
|-- README.md
|-- requirements-ml.lock.txt
|-- requirements-ml.txt
|-- requirements.lock.txt
|-- requirements.txt
|-- risk_engine.py
`-- verify_assets.py
```
