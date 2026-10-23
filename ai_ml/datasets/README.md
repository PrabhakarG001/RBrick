# Dataset directories

The actual existing classifier dataset is `../data/iot_sensor_data.csv`.
Its seven features and `event_label` target are documented in the main README
and checked by `python -m ai_ml.verify_assets`. No data is generated during verification.

These optional staging directories are retained because backend model-status
metadata and frontend documentation reference them:

- `raw/`: future sensor logs or imported datasets.
- `processed/`: future explicit preprocessing outputs.
- `samples/`: fixture documentation.

They are not the source of the current classifier dataset. Live firmware telemetry
uses the validated API schema in `schemas/__init__.py`; its units/features are
not interchangeable with the lesson classifier schema.
