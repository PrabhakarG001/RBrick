# ResillioX Dataset Workspace

This folder is dedicated to housing datasets for the Building Safety, Security, and Maintenance Monitoring System.

## Directory Structure:
- `raw/`: Place raw uncleaned sensor logs, MQTT captures, and incident data here (.csv, .json, .parquet).
- `processed/`: Output directory for cleaned, normalized, time-aligned feature datasets.
- `samples/`: Verified sample benchmark datasets for regression testing and smoke validation.

## Expected Schemas:
Raw sensor data should contain at minimum:
`timestamp`, `device_id`, `temperature`, `humidity`, `gas`, `flame`, `water_leak`, `vibration_rms`, `sos`.
