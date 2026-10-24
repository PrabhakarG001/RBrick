# IoT Building Safety Multi-Label Classifier: Evaluation Report

**Model Version:** `iot-building-safety-multilabel-v1.0.0`  
**Training Timestamp (UTC):** `2026-10-23T22:49:28.292908+00:00`  
**Records:** 8400 train / 1800 validation / 1800 test  
**Primary Dataset:** `C:\Users\Priyanshu Mishra\Downloads\ResillioX\ai_ml\datasets\iot_building_safety_model_input_targets.csv`  

> [!WARNING]
> **Synthetic Data Disclaimer:** Simulated synthetic sensor dataset only. Algorithmic approximations designed for multi-label IoT building safety workflow training. NOT validated real-world physical calibration data.

## 1. Executive Summary & Overall Held-Out Test Metrics

| Metric | Tuned Thresholds | Default 0.50 Threshold |
| :--- | :--- | :--- |
| **Exact-Match (Subset) Accuracy** | **81.22%** | 81.22% |
| **Hamming Loss** | **0.02294** | - |
| **Micro F1-Score** | **0.9251** | - |
| **Micro Precision** | 0.9114 | - |
| **Micro Recall** | 0.9393 | - |
| **Macro F1-Score** | **0.9169** | 0.8805 |
| **Macro Precision** | 0.9121 | - |
| **Macro Recall** | 0.9419 | - |

## 2. Per-Label Detailed Performance on Held-Out Test Split (1,800 records)

| Event Target | Decision Threshold | Precision | Recall | F1-Score | PR-AUC | Support |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `event_fire_suspected` | 0.230 | 0.9658 | 0.9895 | **0.9775** | 0.9950 | 285 |
| `event_smoke_suspected` | 0.370 | 0.9612 | 0.8435 | **0.8986** | 0.9586 | 294 |
| `event_combustible_gas_suspected` | 0.420 | 0.7764 | 0.6971 | **0.7346** | 0.7503 | 274 |
| `event_unauthorized_intrusion` | 0.320 | 0.9683 | 0.9549 | **0.9615** | 0.9959 | 288 |
| `event_vibration_anomaly` | 0.110 | 1.0000 | 1.0000 | **1.0000** | 1.0000 | 299 |
| `event_structural_vibration_review` | 0.050 | 0.4749 | 1.0000 | **0.6440** | 0.5270 | 142 |
| `event_heat_risk` | 0.190 | 0.9888 | 1.0000 | **0.9944** | 1.0000 | 264 |
| `event_high_humidity_mold_risk` | 0.250 | 1.0000 | 1.0000 | **1.0000** | 1.0000 | 282 |
| `event_device_fault` | 0.310 | 0.9894 | 0.9336 | **0.9607** | 0.9827 | 301 |
| `event_network_degradation` | 0.270 | 0.9965 | 1.0000 | **0.9983** | 1.0000 | 288 |

## 3. Confusion Matrices on Held-Out Test Split

| Event Target | True Negatives (TN) | False Positives (FP) | False Negatives (FN) | True Positives (TP) |
| :--- | :---: | :---: | :---: | :---: |
| `event_fire_suspected` | 1505 | 10 | 3 | 282 |
| `event_smoke_suspected` | 1496 | 10 | 46 | 248 |
| `event_combustible_gas_suspected` | 1471 | 55 | 83 | 191 |
| `event_unauthorized_intrusion` | 1503 | 9 | 13 | 275 |
| `event_vibration_anomaly` | 1501 | 0 | 0 | 299 |
| `event_structural_vibration_review` | 1501 | 157 | 0 | 142 |
| `event_heat_risk` | 1533 | 3 | 0 | 264 |
| `event_high_humidity_mold_risk` | 1518 | 0 | 0 | 282 |
| `event_device_fault` | 1496 | 3 | 20 | 281 |
| `event_network_degradation` | 1511 | 1 | 0 | 288 |

## 4. Architectural Analysis & Error Patterns

### High-Risk Life Safety Performance
- **Fire Suspected (`event_fire_suspected`):** Recall is 98.95% with 96.58% precision (F1: 0.9775). Optimal threshold of 0.230 avoids missing flame/heat emergencies while keeping false alarms low (10 FPs out of 1515 true negative instances).
- **Smoke Suspected (`event_smoke_suspected`):** Recall is 84.35% with 96.12% precision (F1: 0.8986).
- **Combustible Gas (`event_combustible_gas_suspected`):** Recall is 69.71% with 77.64% precision (F1: 0.7346). Gas leakage at low concentration deltas near baseline creates minor boundary overlap with normal room conditions.
- **Unauthorized Intrusion (`event_unauthorized_intrusion`):** Recall is 95.49% with 96.83% precision (F1: 0.9615), effectively combining PIR, camera person confidence, after-hours, and restricted zone context.

### Structural & Environmental Performance
- **Vibration Anomaly (`event_vibration_anomaly`):** 100.0% precision, 100.0% recall, and F1 1.0000.
- **Structural Vibration Review (`event_structural_vibration_review`):** Threshold tuning to 0.050 achieved 100.0% recall (142/142 detected) with 157 false positives, prioritizing safety inspection requests so structural risks are flagged.
- **Heat Risk (`event_heat_risk`):** 100.0% recall, 98.88% precision (F1: 0.9944).
- **High Humidity Mold Risk (`event_high_humidity_mold_risk`):** 100.0% precision, 100.0% recall, and F1 1.0000.
- **Device Fault (`event_device_fault`):** Recall is 93.36% with 98.94% precision (F1: 0.9607).
- **Network Degradation (`event_network_degradation`):** 100.0% recall, 99.65% precision (F1: 0.9983).

### Hardware Emergency Override (SOS)
- **`sos_button_pressed` / `event_sos_triggered`:** Intentionally isolated from ML probabilistic classifier.
- Hardware button interrupts execute through a deterministic safety bypass, guaranteeing immediate dispatch.
