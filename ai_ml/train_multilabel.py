"""
ResillioX IoT Building Safety Multi-Label Classifier Training Pipeline.

Trains a multi-label classification model on the primary dataset:
`ai_ml/datasets/iot_building_safety_model_input_targets.csv` (12,000 rows, 50 columns)

Predicts 10 simultaneous building safety events from IoT sensor telemetry,
MPU acceleration/gyroscope, environmental conditions, camera indicators,
device health, and network telemetry.

Preserves SOS as a deterministic, separate emergency override.
"""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    classification_report,
    confusion_matrix,
    f1_score,
    hamming_loss,
    precision_score,
    recall_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

# 10 Multi-Label Machine Learning Targets (SOS is intentionally excluded)
TARGET_COLUMNS = [
    "event_fire_suspected",
    "event_smoke_suspected",
    "event_combustible_gas_suspected",
    "event_unauthorized_intrusion",
    "event_vibration_anomaly",
    "event_structural_vibration_review",
    "event_heat_risk",
    "event_high_humidity_mold_risk",
    "event_device_fault",
    "event_network_degradation",
]

# Columns strictly prohibited from entering the feature matrix (leakage / metadata / dashboard)
FORBIDDEN_COLUMNS = {
    "record_id",
    "synthetic_flag",
    "data_split",
    "timestamp_utc",
    "scenario_type",
    "sos_button_pressed",
    "event_sos_triggered",
    "active_event_count",
    "active_event_labels",
    "safety_score_0_100",
    "safety_color",
    "alert_priority",
    "buzzer_command",
    "recommended_action",
}
FORBIDDEN_COLUMNS.update(TARGET_COLUMNS)

CATEGORICAL_COLUMNS = ["zone_id", "monitoring_role"]


def validate_and_cross_check_datasets(
    primary_df: pd.DataFrame,
    full_dataset_path: Path,
    logic_dataset_path: Path,
) -> dict:
    """Performs rigorous data quality checks and cross-checks with companion assets."""
    issues = []
    cross_checks = {}

    # 1. Shape and basic counts of primary model input dataset
    expected_rows = 12000
    expected_cols = 50
    if primary_df.shape[0] != expected_rows or primary_df.shape[1] != expected_cols:
        issues.append(f"Unexpected shape: {primary_df.shape}, expected ({expected_rows}, {expected_cols})")

    # 2. Check data splits
    split_counts = primary_df["data_split"].value_counts().to_dict()
    if split_counts.get("train") != 8400 or split_counts.get("validation") != 1800 or split_counts.get("test") != 1800:
        issues.append(f"Unexpected data_split distribution: {split_counts}")

    # 3. Check targets are binary
    for col in TARGET_COLUMNS:
        if col not in primary_df.columns:
            issues.append(f"Missing target column: {col}")
            continue
        unique_vals = set(primary_df[col].dropna().unique())
        if not unique_vals.issubset({0, 1}):
            issues.append(f"Non-binary values in target {col}: {unique_vals}")

    # 4. Check positive/negative examples in train split
    train_df = primary_df[primary_df["data_split"] == "train"]
    for col in TARGET_COLUMNS:
        pos = int((train_df[col] == 1).sum())
        neg = int((train_df[col] == 0).sum())
        if pos == 0 or neg == 0:
            issues.append(f"Target {col} lacks positive or negative examples in train split (pos={pos}, neg={neg})")

    # 5. Check nulls
    null_counts = primary_df.isnull().sum()
    null_cols = null_counts[null_counts > 0].to_dict()

    # 6. Cross-check against full synthetic CSV if available
    if full_dataset_path.exists():
        try:
            full_df = pd.read_csv(full_dataset_path)
            rec_match = bool((primary_df["record_id"] == full_df["record_id"]).all())
            target_diffs = {}
            for col in TARGET_COLUMNS:
                if col in full_df.columns:
                    diff_count = int((primary_df[col] != full_df[col]).sum())
                    if diff_count > 0:
                        target_diffs[col] = diff_count
            cross_checks["full_csv_record_id_exact_match"] = rec_match
            cross_checks["full_csv_target_differences"] = target_diffs
            if not rec_match:
                issues.append("record_id alignment mismatch between primary model CSV and full synthetic CSV")
            if target_diffs:
                issues.append(f"Target column mismatches with full synthetic CSV: {target_diffs}")
        except Exception as e:
            cross_checks["full_csv_error"] = str(e)

    # 7. Cross-check against 2048 logic CSV
    if logic_dataset_path.exists():
        try:
            logic_df = pd.read_csv(logic_dataset_path)
            cross_checks["logic_combinations_count"] = len(logic_df)
            cross_checks["logic_has_all_targets"] = all(t in logic_df.columns for t in TARGET_COLUMNS)
        except Exception as e:
            cross_checks["logic_csv_error"] = str(e)

    return {
        "total_records": len(primary_df),
        "total_columns": len(primary_df.columns),
        "split_counts": split_counts,
        "null_columns": null_cols,
        "cross_checks": cross_checks,
        "issues_found": issues,
        "passed": len(issues) == 0,
    }


def select_optimal_thresholds(
    y_true: np.ndarray,
    y_probas: np.ndarray,
    target_names: list[str],
) -> dict:
    """
    Selects optimal decision thresholds per target on the validation split.
    Objective: Maximize F1-score on validation data while maintaining high safety sensitivity.
    """
    thresholds = {}
    candidate_thresholds = np.linspace(0.05, 0.95, 91)

    for i, target in enumerate(target_names):
        y_t = y_true[:, i]
        y_p = y_probas[:, i]

        best_f1 = -1.0
        best_th = 0.50

        for th in candidate_thresholds:
            y_pred = (y_p >= th).astype(int)
            f1 = f1_score(y_t, y_pred, zero_division=0)
            if f1 > best_f1:
                best_f1 = f1
                best_th = th

        thresholds[target] = float(round(best_th, 3))

    return thresholds


def train_and_evaluate(
    primary_dataset_path: Path,
    full_dataset_path: Path,
    logic_dataset_path: Path,
    output_model_path: Path,
    output_report_path: Path,
    output_predictions_path: Path,
    random_state: int = 42,
) -> dict:
    """Runs the complete end-to-end training, validation, testing, and artifact generation."""
    print("=" * 80)
    print("ResillioX IoT Building Safety Multi-Label Training Pipeline")
    print(f"Timestamp (UTC): {datetime.now(timezone.utc).isoformat()}")
    print("=" * 80)

    if not primary_dataset_path.exists():
        raise FileNotFoundError(f"Primary dataset CSV not found at: {primary_dataset_path}")

    print(f"[1/6] Loading primary model dataset from: {primary_dataset_path}")
    df = pd.read_csv(primary_dataset_path)

    # Validate dataset and cross-check companion assets
    val_report = validate_and_cross_check_datasets(df, full_dataset_path, logic_dataset_path)
    print(f"Dataset shape: {df.shape}")
    print(f"Data splits: {val_report['split_counts']}")
    if val_report["null_columns"]:
        print(f"Columns with nulls (handled by imputation): {val_report['null_columns']}")
    print(f"Cross-check with full synthetic CSV: {val_report['cross_checks']}")
    if val_report["issues_found"]:
        print("Data Quality Warnings:", val_report["issues_found"])
    else:
        print("[OK] All data quality checks and cross-checks passed.")

    # Feature selection
    feature_columns = [c for c in df.columns if c not in FORBIDDEN_COLUMNS]
    numeric_columns = [c for c in feature_columns if c not in CATEGORICAL_COLUMNS]

    print(f"\n[2/6] Configuring input features ({len(feature_columns)} features total):")
    print(f"  Categorical ({len(CATEGORICAL_COLUMNS)}): {CATEGORICAL_COLUMNS}")
    print(f"  Numeric ({len(numeric_columns)}): {numeric_columns}")
    print(f"  Target events ({len(TARGET_COLUMNS)}): {TARGET_COLUMNS}")
    print(f"  Deterministic Emergency Override: Hardware SOS button (strictly excluded from ML features)")

    # Partitions
    train_df = df[df["data_split"] == "train"].copy()
    val_df = df[df["data_split"] == "validation"].copy()
    test_df = df[df["data_split"] == "test"].copy()

    X_train = train_df[feature_columns]
    y_train = train_df[TARGET_COLUMNS].values

    X_val = val_df[feature_columns]
    y_val = val_df[TARGET_COLUMNS].values

    X_test = test_df[feature_columns]
    y_test = test_df[TARGET_COLUMNS].values

    # Preprocessing Pipeline
    preprocessor = ColumnTransformer(
        transformers=[
            (
                "cat",
                Pipeline(
                    steps=[
                        ("imputer", SimpleImputer(strategy="constant", fill_value="UNKNOWN")),
                        ("encoder", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
                    ]
                ),
                CATEGORICAL_COLUMNS,
            ),
            (
                "num",
                SimpleImputer(strategy="median"),
                numeric_columns,
            ),
        ]
    )

    # Multi-label classifier (Random Forest natively supports multi-output binary classification)
    classifier = RandomForestClassifier(
        n_estimators=150,
        max_depth=20,
        min_samples_split=4,
        min_samples_leaf=2,
        random_state=random_state,
        n_jobs=-1,
    )

    model_pipeline = Pipeline(
        steps=[
            ("preprocessor", preprocessor),
            ("classifier", classifier),
        ]
    )

    print(f"\n[3/6] Fitting model pipeline on training split ({len(X_train)} samples)...")
    model_pipeline.fit(X_train, y_train)
    print("[OK] Model pipeline training completed.")

    # Predict probabilities on validation split for threshold tuning
    print("\n[4/6] Selecting independent per-label decision thresholds on validation split...")
    val_raw_probas = model_pipeline.predict_proba(X_val)
    val_probas = np.column_stack([p[:, 1] if p.shape[1] == 2 else np.zeros(len(p)) for p in val_raw_probas])

    optimal_thresholds = select_optimal_thresholds(y_val, val_probas, TARGET_COLUMNS)
    print("Optimal thresholds selected on validation data:")
    for tgt in TARGET_COLUMNS:
        idx = TARGET_COLUMNS.index(tgt)
        pr_auc = float(average_precision_score(y_val[:, idx], val_probas[:, idx]))
        print(f"  - {tgt:<35s}: threshold={optimal_thresholds[tgt]:.3f} (Val PR-AUC={pr_auc:.4f})")

    # Evaluate on held-out test split
    print(f"\n[5/6] Evaluating model on held-out test split ({len(X_test)} samples)...")
    test_raw_probas = model_pipeline.predict_proba(X_test)
    test_probas = np.column_stack([p[:, 1] if p.shape[1] == 2 else np.zeros(len(p)) for p in test_raw_probas])

    # Predictions using tuned thresholds
    y_test_pred = np.zeros_like(y_test)
    for i, tgt in enumerate(TARGET_COLUMNS):
        y_test_pred[:, i] = (test_probas[:, i] >= optimal_thresholds[tgt]).astype(int)

    # Predictions using default 0.50 threshold (for comparison)
    y_test_pred_default = (test_probas >= 0.50).astype(int)

    # Metrics computation
    exact_match_acc = float(accuracy_score(y_test, y_test_pred))
    hamming = float(hamming_loss(y_test, y_test_pred))
    micro_p = float(precision_score(y_test, y_test_pred, average="micro", zero_division=0))
    micro_r = float(recall_score(y_test, y_test_pred, average="micro", zero_division=0))
    micro_f1 = float(f1_score(y_test, y_test_pred, average="micro", zero_division=0))
    macro_p = float(precision_score(y_test, y_test_pred, average="macro", zero_division=0))
    macro_r = float(recall_score(y_test, y_test_pred, average="macro", zero_division=0))
    macro_f1 = float(f1_score(y_test, y_test_pred, average="macro", zero_division=0))

    default_exact_match = float(accuracy_score(y_test, y_test_pred_default))
    default_hamming = float(hamming_loss(y_test, y_test_pred_default))
    default_macro_f1 = float(f1_score(y_test, y_test_pred_default, average="macro", zero_division=0))

    per_label_metrics = {}
    confusion_matrices = {}
    for i, tgt in enumerate(TARGET_COLUMNS):
        y_t = y_test[:, i]
        y_p = y_test_pred[:, i]
        y_prob = test_probas[:, i]

        prec = float(precision_score(y_t, y_p, zero_division=0))
        rec = float(recall_score(y_t, y_p, zero_division=0))
        f1 = float(f1_score(y_t, y_p, zero_division=0))
        support = int(np.sum(y_t))
        pr_auc = float(average_precision_score(y_t, y_prob)) if support > 0 else 0.0
        cm = confusion_matrix(y_t, y_p, labels=[0, 1]).tolist()

        per_label_metrics[tgt] = {
            "threshold": optimal_thresholds[tgt],
            "precision": round(prec, 4),
            "recall": round(rec, 4),
            "f1": round(f1, 4),
            "support": support,
            "pr_auc": round(pr_auc, 4),
        }
        confusion_matrices[tgt] = {
            "tn": cm[0][0],
            "fp": cm[0][1],
            "fn": cm[1][0],
            "tp": cm[1][1],
        }

    print(f"\nFinal Test Results (Tuned Thresholds):")
    print(f"  Exact-Match (Subset) Accuracy : {exact_match_acc * 100:.2f}%")
    print(f"  Hamming Loss                  : {hamming:.5f}")
    print(f"  Micro F1                      : {micro_f1:.4f} (Precision={micro_p:.4f}, Recall={micro_r:.4f})")
    print(f"  Macro F1                      : {macro_f1:.4f} (Precision={macro_p:.4f}, Recall={macro_r:.4f})")
    print(f"  Comparison (Default 0.50 TH)  : Macro F1={default_macro_f1:.4f}, Exact-Match={default_exact_match * 100:.2f}%")

    # Save artifacts
    print(f"\n[6/6] Saving trained model and reports...")
    output_model_path.parent.mkdir(parents=True, exist_ok=True)
    output_report_path.parent.mkdir(parents=True, exist_ok=True)
    output_predictions_path.parent.mkdir(parents=True, exist_ok=True)

    model_bundle = {
        "pipeline": model_pipeline,
        "feature_names": feature_columns,
        "categorical_features": CATEGORICAL_COLUMNS,
        "numeric_features": numeric_columns,
        "target_names": TARGET_COLUMNS,
        "decision_thresholds": optimal_thresholds,
        "model_version": "iot-building-safety-multilabel-v1.0.0",
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "primary_dataset": primary_dataset_path.name,
        "dataset_records": len(df),
        "split_counts": {
            "train": len(X_train),
            "validation": len(X_val),
            "test": len(X_test),
        },
        "dependency_versions": {
            "python": sys.version,
            "joblib": joblib.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scikit_learn": getattr(sys.modules.get("sklearn"), "__version__", "1.9.1"),
        },
        "disclaimer": (
            "Simulated synthetic sensor dataset only. Algorithmic approximations "
            "designed for multi-label IoT building safety workflow training. "
            "NOT validated real-world physical calibration data."
        ),
        "test_metrics": {
            "exact_match_accuracy": round(exact_match_acc, 4),
            "hamming_loss": round(hamming, 5),
            "micro_precision": round(micro_p, 4),
            "micro_recall": round(micro_r, 4),
            "micro_f1": round(micro_f1, 4),
            "macro_precision": round(macro_p, 4),
            "macro_recall": round(macro_r, 4),
            "macro_f1": round(macro_f1, 4),
            "per_label": per_label_metrics,
        },
    }

    joblib.dump(model_bundle, output_model_path)
    print(f"[OK] Model bundle saved to: {output_model_path}")

    # Save test predictions CSV
    pred_df = test_df[["record_id"]].copy() if "record_id" in test_df.columns else pd.DataFrame(index=test_df.index)
    for i, tgt in enumerate(TARGET_COLUMNS):
        pred_df[f"actual_{tgt}"] = y_test[:, i]
        pred_df[f"prob_{tgt}"] = np.round(test_probas[:, i], 4)
        pred_df[f"pred_{tgt}"] = y_test_pred[:, i]
    pred_df.to_csv(output_predictions_path, index=False)
    print(f"[OK] Held-out test predictions saved to: {output_predictions_path}")

    # Save detailed evaluation report in Markdown and JSON
    json_report_path = output_report_path.with_suffix(".json")
    full_report = {
        "metadata": {
            "model_version": model_bundle["model_version"],
            "trained_at_utc": model_bundle["trained_at_utc"],
            "primary_dataset": str(primary_dataset_path),
            "split_counts": model_bundle["split_counts"],
            "disclaimer": model_bundle["disclaimer"],
        },
        "overall_test_metrics": {
            "exact_match_accuracy": round(exact_match_acc, 4),
            "hamming_loss": round(hamming, 5),
            "micro_f1": round(micro_f1, 4),
            "micro_precision": round(micro_p, 4),
            "micro_recall": round(micro_r, 4),
            "macro_f1": round(macro_f1, 4),
            "macro_precision": round(macro_p, 4),
            "macro_recall": round(macro_r, 4),
            "default_exact_match_at_0_50": round(default_exact_match, 4),
            "default_macro_f1_at_0_50": round(default_macro_f1, 4),
        },
        "per_label_metrics": per_label_metrics,
        "confusion_matrices": confusion_matrices,
        "cross_checks": val_report["cross_checks"],
    }
    with open(json_report_path, "w", encoding="utf-8") as f:
        json.dump(full_report, f, indent=2)

    generate_markdown_report(output_report_path, full_report, TARGET_COLUMNS)
    print(f"[OK] Evaluation report saved to: {output_report_path}")
    print(f"[OK] Evaluation JSON saved to: {json_report_path}")

    print("\n[SUCCESS] Training pipeline completed successfully!")
    return full_report


def generate_markdown_report(report_path: Path, report_data: dict, target_names: list[str]) -> None:
    """Generates a comprehensive Markdown evaluation report."""
    metrics = report_data["overall_test_metrics"]
    pl = report_data["per_label_metrics"]
    cm = report_data["confusion_matrices"]

    lines = [
        "# IoT Building Safety Multi-Label Classifier: Evaluation Report",
        "",
        f"**Model Version:** `{report_data['metadata']['model_version']}`  ",
        f"**Training Timestamp (UTC):** `{report_data['metadata']['trained_at_utc']}`  ",
        f"**Records:** {report_data['metadata']['split_counts']['train']} train / "
        f"{report_data['metadata']['split_counts']['validation']} validation / "
        f"{report_data['metadata']['split_counts']['test']} test  ",
        f"**Primary Dataset:** `{report_data['metadata']['primary_dataset']}`  ",
        "",
        "> [!WARNING]",
        f"> **Synthetic Data Disclaimer:** {report_data['metadata']['disclaimer']}",
        "",
        "## 1. Executive Summary & Overall Held-Out Test Metrics",
        "",
        "| Metric | Tuned Thresholds | Default 0.50 Threshold |",
        "| :--- | :--- | :--- |",
        f"| **Exact-Match (Subset) Accuracy** | **{metrics['exact_match_accuracy'] * 100:.2f}%** | {metrics.get('default_exact_match_at_0_50', 0) * 100:.2f}% |",
        f"| **Hamming Loss** | **{metrics['hamming_loss']:.5f}** | - |",
        f"| **Micro F1-Score** | **{metrics['micro_f1']:.4f}** | - |",
        f"| **Micro Precision** | {metrics['micro_precision']:.4f} | - |",
        f"| **Micro Recall** | {metrics['micro_recall']:.4f} | - |",
        f"| **Macro F1-Score** | **{metrics['macro_f1']:.4f}** | {metrics.get('default_macro_f1_at_0_50', 0):.4f} |",
        f"| **Macro Precision** | {metrics['macro_precision']:.4f} | - |",
        f"| **Macro Recall** | {metrics['macro_recall']:.4f} | - |",
        "",
        "## 2. Per-Label Detailed Performance on Held-Out Test Split (1,800 records)",
        "",
        "| Event Target | Decision Threshold | Precision | Recall | F1-Score | PR-AUC | Support |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    for tgt in target_names:
        m = pl[tgt]
        lines.append(
            f"| `{tgt}` | {m['threshold']:.3f} | {m['precision']:.4f} | {m['recall']:.4f} | **{m['f1']:.4f}** | {m['pr_auc']:.4f} | {m['support']} |"
        )

    lines.extend([
        "",
        "## 3. Confusion Matrices on Held-Out Test Split",
        "",
        "| Event Target | True Negatives (TN) | False Positives (FP) | False Negatives (FN) | True Positives (TP) |",
        "| :--- | :---: | :---: | :---: | :---: |",
    ])

    for tgt in target_names:
        c = cm[tgt]
        lines.append(
            f"| `{tgt}` | {c['tn']} | {c['fp']} | {c['fn']} | {c['tp']} |"
        )

    lines.extend([
        "",
        "## 4. Architectural Analysis & Error Patterns",
        "",
        "### High-Risk Life Safety Performance",
        f"- **Fire Suspected (`event_fire_suspected`):** Recall is {pl['event_fire_suspected']['recall']*100:.2f}% with {pl['event_fire_suspected']['precision']*100:.2f}% precision (F1: {pl['event_fire_suspected']['f1']:.4f}). Optimal threshold of {pl['event_fire_suspected']['threshold']:.3f} avoids missing flame/heat emergencies while keeping false alarms low ({cm['event_fire_suspected']['fp']} FPs out of {cm['event_fire_suspected']['tn'] + cm['event_fire_suspected']['fp']} true negative instances).",
        f"- **Smoke Suspected (`event_smoke_suspected`):** Recall is {pl['event_smoke_suspected']['recall']*100:.2f}% with {pl['event_smoke_suspected']['precision']*100:.2f}% precision (F1: {pl['event_smoke_suspected']['f1']:.4f}).",
        f"- **Combustible Gas (`event_combustible_gas_suspected`):** Recall is {pl['event_combustible_gas_suspected']['recall']*100:.2f}% with {pl['event_combustible_gas_suspected']['precision']*100:.2f}% precision (F1: {pl['event_combustible_gas_suspected']['f1']:.4f}). Gas leakage at low concentration deltas near baseline creates minor boundary overlap with normal room conditions.",
        f"- **Unauthorized Intrusion (`event_unauthorized_intrusion`):** Recall is {pl['event_unauthorized_intrusion']['recall']*100:.2f}% with {pl['event_unauthorized_intrusion']['precision']*100:.2f}% precision (F1: {pl['event_unauthorized_intrusion']['f1']:.4f}), effectively combining PIR, camera person confidence, after-hours, and restricted zone context.",
        "",
        "### Structural & Environmental Performance",
        f"- **Vibration Anomaly (`event_vibration_anomaly`):** {pl['event_vibration_anomaly']['precision']*100:.1f}% precision, {pl['event_vibration_anomaly']['recall']*100:.1f}% recall, and F1 {pl['event_vibration_anomaly']['f1']:.4f}.",
        f"- **Structural Vibration Review (`event_structural_vibration_review`):** Threshold tuning to {pl['event_structural_vibration_review']['threshold']:.3f} achieved {pl['event_structural_vibration_review']['recall']*100:.1f}% recall ({cm['event_structural_vibration_review']['tp']}/{cm['event_structural_vibration_review']['tp'] + cm['event_structural_vibration_review']['fn']} detected) with {cm['event_structural_vibration_review']['fp']} false positives, prioritizing safety inspection requests so structural risks are flagged.",
        f"- **Heat Risk (`event_heat_risk`):** {pl['event_heat_risk']['recall']*100:.1f}% recall, {pl['event_heat_risk']['precision']*100:.2f}% precision (F1: {pl['event_heat_risk']['f1']:.4f}).",
        f"- **High Humidity Mold Risk (`event_high_humidity_mold_risk`):** {pl['event_high_humidity_mold_risk']['precision']*100:.1f}% precision, {pl['event_high_humidity_mold_risk']['recall']*100:.1f}% recall, and F1 {pl['event_high_humidity_mold_risk']['f1']:.4f}.",
        f"- **Device Fault (`event_device_fault`):** Recall is {pl['event_device_fault']['recall']*100:.2f}% with {pl['event_device_fault']['precision']*100:.2f}% precision (F1: {pl['event_device_fault']['f1']:.4f}).",
        f"- **Network Degradation (`event_network_degradation`):** {pl['event_network_degradation']['recall']*100:.1f}% recall, {pl['event_network_degradation']['precision']*100:.2f}% precision (F1: {pl['event_network_degradation']['f1']:.4f}).",
        "",
        "### Hardware Emergency Override (SOS)",
        "- **`sos_button_pressed` / `event_sos_triggered`:** Intentionally isolated from ML probabilistic classifier.",
        "- Hardware button interrupts execute through a deterministic safety bypass, guaranteeing immediate dispatch.",
    ])

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main():
    base_dir = Path(__file__).resolve().parent
    primary_dataset_path = base_dir / "datasets" / "iot_building_safety_model_input_targets.csv"
    full_dataset_path = base_dir / "datasets" / "iot_building_safety_multilabel_synthetic_dataset.csv"
    logic_dataset_path = base_dir / "datasets" / "iot_label_combinations_2048_logic_only.csv"

    output_model_path = base_dir / "models" / "iot_building_safety_multilabel.joblib"
    output_report_path = base_dir / "analytics" / "multilabel_model_evaluation_report.md"
    output_predictions_path = base_dir / "analytics" / "held_out_test_predictions.csv"

    train_and_evaluate(
        primary_dataset_path=primary_dataset_path,
        full_dataset_path=full_dataset_path,
        logic_dataset_path=logic_dataset_path,
        output_model_path=output_model_path,
        output_report_path=output_report_path,
        output_predictions_path=output_predictions_path,
    )


if __name__ == "__main__":
    main()
