"""
IoT Safety Monitoring Project - Lesson 1: Machine Learning Classifier
Author: Priyanshu Mishra
Directory: C:\\Users\\Priyanshu Mishra\\Documents\\iot-ml-project

DISCLAIMER:
Simulated sensor readings and labels generated in this script are algorithmic
approximations designed for initial machine-learning workflow training.
They are NOT validated real-world physical calibration data. Real sensors require
hardware warm-up periods, baseline zeroing, and physical environmental calibration.

ARCHITECTURAL NOTE ON SOS BUTTON:
The hardware SOS emergency button is intentionally excluded from the AI feature set.
In production safety systems, an SOS button press is a deterministic, safety-critical
hardware interrupt that must trigger an immediate alarm/dispatch directly. It should
never be routed through a probabilistic ML classification model.
"""

from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import train_test_split


def generate_synthetic_iot_data(
    samples_per_class: int = 250, random_seed: int = 42
) -> pd.DataFrame:
    """Generates 1,250 balanced synthetic sensor records across 5 safety scenarios.

    Features:
      - temperature_c: DHT22 ambient temperature (Celsius)
      - humidity_pct: DHT22 relative humidity (%)
      - accel_magnitude_g: MPU6050 vector acceleration magnitude (g = 9.81 m/s^2)
                           At rest, gravity produces a magnitude of ~1.0g.
      - sw420_vibration: SW420 digital shock/vibration trigger (0 = Still, 1 = Shaking)
      - mq2_raw: MQ-2 analog ADC smoke/flammable gas reading (illustrative 0-1023 scale)
      - motion_detected: PIR motion sensor digital trigger (0 = Idle, 1 = Movement)
      - flame_detected: IR optical flame sensor digital trigger (0 = No Flame, 1 = Flame)
    """
    np.random.seed(random_seed)
    records = []

    # Scenario 1: NORMAL (Healthy ambient room operation)
    for _ in range(samples_per_class):
        records.append(
            {
                "temperature_c": np.random.normal(loc=25.0, scale=3.0),
                "humidity_pct": np.random.normal(loc=50.0, scale=6.0),
                "accel_magnitude_g": np.random.normal(loc=1.00, scale=0.03),
                "sw420_vibration": 0,
                "mq2_raw": np.random.uniform(120.0, 280.0),
                "motion_detected": 0,
                "flame_detected": 0,
                "event_label": "NORMAL",
            }
        )

    # Scenario 2: GAS_SMOKE_EVENT (Gas leak or smoldering smoke without flame)
    for _ in range(samples_per_class):
        records.append(
            {
                "temperature_c": np.random.normal(loc=27.0, scale=4.0),
                "humidity_pct": np.random.normal(loc=48.0, scale=6.0),
                "accel_magnitude_g": np.random.normal(loc=1.00, scale=0.03),
                "sw420_vibration": 0,
                "mq2_raw": np.random.uniform(
                    650.0, 950.0
                ),  # Elevated gas/smoke reading
                "motion_detected": 0,
                "flame_detected": 0,
                "event_label": "GAS_SMOKE_EVENT",
            }
        )

    # Scenario 3: VIBRATION_EVENT (Mechanical fault, impact, or tampering)
    for _ in range(samples_per_class):
        records.append(
            {
                "temperature_c": np.random.normal(loc=26.0, scale=3.0),
                "humidity_pct": np.random.normal(loc=50.0, scale=6.0),
                "accel_magnitude_g": np.random.uniform(
                    1.80, 4.20
                ),  # Significant acceleration spike
                "sw420_vibration": 1,  # Digital shock sensor triggered
                "mq2_raw": np.random.uniform(140.0, 300.0),
                "motion_detected": np.random.choice([0, 1], p=[0.7, 0.3]),
                "flame_detected": 0,
                "event_label": "VIBRATION_EVENT",
            }
        )

    # Scenario 4: FIRE_SUSPECTED (Open flame optical detection + heat + smoke)
    for _ in range(samples_per_class):
        records.append(
            {
                "temperature_c": np.random.uniform(55.0, 90.0),  # Intense heat
                "humidity_pct": np.random.uniform(
                    15.0, 35.0
                ),  # Hot air causes lower relative humidity
                "accel_magnitude_g": np.random.normal(loc=1.02, scale=0.05),
                "sw420_vibration": 0,
                "mq2_raw": np.random.uniform(520.0, 900.0),  # Combustion gases
                "motion_detected": 0,
                "flame_detected": 1,  # Optical IR flame detected
                "event_label": "FIRE_SUSPECTED",
            }
        )

    # Scenario 5: MOTION_EVENT (Room activity detected; safety conditions normal)
    for _ in range(samples_per_class):
        records.append(
            {
                "temperature_c": np.random.normal(loc=25.0, scale=3.0),
                "humidity_pct": np.random.normal(loc=50.0, scale=6.0),
                "accel_magnitude_g": np.random.normal(loc=1.00, scale=0.03),
                "sw420_vibration": 0,
                "mq2_raw": np.random.uniform(130.0, 290.0),
                "motion_detected": 1,  # PIR sensor active
                "flame_detected": 0,
                "event_label": "MOTION_EVENT",
            }
        )

    df = pd.DataFrame(records)

    # Round floating-point measurements to realistic sensor precision
    df["temperature_c"] = df["temperature_c"].round(1)
    df["humidity_pct"] = df["humidity_pct"].round(1)
    df["accel_magnitude_g"] = df["accel_magnitude_g"].round(2)
    df["mq2_raw"] = df["mq2_raw"].round(0).astype(int)

    # Shuffle rows so classes are not grouped sequentially
    df = df.sample(frac=1.0, random_state=random_seed).reset_index(drop=True)
    return df


def print_confusion_matrix(cm: np.ndarray, labels: list[str]) -> None:
    """Displays a clearly formatted text confusion matrix."""
    header = f"{'Actual \\ Predicted':<22}" + "".join(
        [f"{label:>18}" for label in labels]
    )
    print(header)
    print("-" * len(header))
    for i, actual_label in enumerate(labels):
        row_str = f"{actual_label:<22}" + "".join(
            [f"{cm[i, j]:>18}" for j in range(len(labels))]
        )
        print(row_str)


def main():
    project_dir = Path(__file__).resolve().parent

    print("=" * 70)
    print("  STEP 1: Generating Synthetic IoT Safety Sensor Dataset")
    print("=" * 70)
    df = generate_synthetic_iot_data(samples_per_class=250, random_seed=42)

    csv_path = project_dir / "iot_sensor_data.csv"
    df.to_csv(csv_path, index=False)
    print(f"[OK] Generated {len(df)} total sensor records.")
    print(f"[OK] Saved dataset strictly inside project directory: {csv_path.name}")
    print("\nDataset Class Distribution:")
    print(df["event_label"].value_counts())

    print("\n" + "=" * 70)
    print("  STEP 2: Preparing Features (X) and Target (y)")
    print("=" * 70)
    feature_columns = [
        "temperature_c",
        "humidity_pct",
        "accel_magnitude_g",
        "sw420_vibration",
        "mq2_raw",
        "motion_detected",
        "flame_detected",
    ]
    X = df[feature_columns]
    y = df["event_label"]

    # 80% training set, 20% held-out test set (stratified to maintain balanced classes)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.20, random_state=42, stratify=y
    )
    print(f"Features: {feature_columns}")
    print(f"Training set: {len(X_train)} samples")
    print(f"Testing set:  {len(X_test)} samples")

    print("\n" + "=" * 70)
    print("  STEP 3: Training Random Forest Classifier")
    print("=" * 70)
    # n_estimators=100 creates an ensemble of 100 independent decision trees
    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)
    print("[OK] Model training complete.")

    print("\n" + "=" * 70)
    print("  STEP 4: Evaluating Model on Held-Out Test Data")
    print("=" * 70)
    y_pred = model.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    print(f"Overall Accuracy: {accuracy * 100:.2f}%\n")

    print("Detailed Classification Report (Precision, Recall, F1-Score):")
    print(classification_report(y_test, y_pred, digits=4))

    print("Confusion Matrix:")
    labels = sorted(list(y.unique()))
    cm = confusion_matrix(y_test, y_pred, labels=labels)
    print_confusion_matrix(cm, labels)

    print("\n" + "=" * 70)
    print("  STEP 5: Saving Model and Metadata with Joblib")
    print("=" * 70)
    model_path = project_dir / "iot_sensor_model.joblib"
    # Bundling feature column names guarantees consistent schema during backend inference
    model_bundle = {
        "model": model,
        "feature_names": feature_columns,
        "classes": list(model.classes_),
        "metadata": {
            "description": "IoT Safety Multi-Class Classifier (Lesson 1)",
            "sensors": ["DHT22", "MPU6050", "SW420", "MQ-2", "PIR", "Flame"],
        },
    }
    joblib.dump(model_bundle, model_path)
    print(f"[OK] Saved model bundle to: {model_path.name}")

    print("\n" + "=" * 70)
    print("  STEP 6: Reloading Saved Model & Simulating Sample Prediction")
    print("=" * 70)
    # Reload bundle from disk (exactly as a future Flask/FastAPI backend will)
    loaded_bundle = joblib.load(model_path)
    deployed_model = loaded_bundle["model"]
    expected_features = loaded_bundle["feature_names"]

    # Sample reading simulating an incoming reading from an MQ-2 smoke/gas trigger:
    sample_reading = pd.DataFrame(
        [
            {
                "temperature_c": 28.5,  # Ambient
                "humidity_pct": 47.0,  # Ambient
                "accel_magnitude_g": 1.01,  # Machine resting
                "sw420_vibration": 0,  # No vibration
                "mq2_raw": 780,  # Elevated smoke/gas
                "motion_detected": 0,  # No movement
                "flame_detected": 0,  # No open flame
            }
        ]
    )[expected_features]

    print("Incoming Sample Reading:")
    print(sample_reading.to_string(index=False))

    prediction = deployed_model.predict(sample_reading)[0]
    probabilities = deployed_model.predict_proba(sample_reading)[0]

    print(f"\nPredicted Category: >>> {prediction} <<<")
    print("\nEnsemble Tree Voting Distribution:")
    for cls_name, prob in zip(deployed_model.classes_, probabilities):
        print(f"  - {cls_name:<18}: {prob * 100:5.1f}% of trees voted for this")

    print("\nIMPORTANT INTERPRETATION NOTE:")
    print(
        "Random Forest voting percentages reflect the proportion of decision trees in"
    )
    print(
        "the ensemble agreeing on the label. They should NOT be treated as guaranteed"
    )
    print(
        "real-world Bayesian certainty. A calibrated safety threshold and physical"
    )
    print("verification are always required for safety-critical deployments.")

    print("\n[SUCCESS] Program completed successfully.")


if __name__ == "__main__":
    main()
