"""Read-only verification of the preserved dataset and trusted existing model.

Run from the repository root: python -m ai_ml.verify_assets
Never trains, rewrites data, or serializes model artifacts.
"""
import csv
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from . import lesson1_ml


def verify_assets():
    path = lesson1_ml.DATASET_PATH
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        columns = reader.fieldnames
        rows = list(reader)
    expected = lesson1_ml.FEATURE_COLUMNS + ["event_label"]
    errors = []
    if columns != expected:
        errors.append("Dataset columns/order do not match the classifier schema")
    if not rows:
        errors.append("Dataset is empty")
    missing = 0
    ranges = {key: [] for key in lesson1_ml.FEATURE_COLUMNS}
    for index, row in enumerate(rows, start=2):
        if None in row or any(value is None or value.strip() == "" for value in row.values()):
            missing += 1
            errors.append(f"Missing or surplus fields at CSV line {index}")
            continue
        for feature in lesson1_ml.FEATURE_COLUMNS:
            try:
                value = float(row[feature])
                if not math.isfinite(value):
                    raise ValueError()
                if feature in {"sw420_vibration", "motion_detected", "flame_detected"} and value not in {0, 1}:
                    raise ValueError()
                ranges[feature].append(value)
            except (ValueError, KeyError, TypeError):
                errors.append(f"Invalid numeric/boolean {feature} at CSV line {index}")
        if row.get("event_label") not in lesson1_ml.CLASS_LABELS:
            errors.append(f"Unknown target label at CSV line {index}")
    report = {
        "dataset": {"path": str(path.relative_to(Path.cwd())), "rows": len(rows), "columns": len(columns or []),
                    "feature_names": lesson1_ml.FEATURE_COLUMNS, "target": "event_label",
                    "labels": dict(Counter(row.get("event_label") for row in rows)),
                    "missing_rows": missing, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "ranges": {key: [min(values), max(values)] if values else None for key, values in ranges.items()},
                    "errors": errors, "status": "VERIFIED" if not errors else "FAILED"},
    }
    state = lesson1_ml.load_model_bundle(force_reload=True)
    model_path = lesson1_ml._find_model_file()
    model = {"path": str(model_path.relative_to(Path.cwd())) if model_path else None,
             "status": "VERIFIED" if state["available"] else state.get("status", "MODEL_VERIFICATION_FAILED"),
             "reason": state.get("reason"), "type": None, "samples": []}
    if state["available"] and not errors:
        import importlib.metadata
        model["dependency_versions"] = {name: importlib.metadata.version(name)
                                        for name in ["scikit-learn", "joblib", "numpy", "pandas", "scipy"]}
        model["type"] = type(lesson1_ml._bundle_cache["model"]).__name__
        model["sha256"] = hashlib.sha256(model_path.read_bytes()).hexdigest()
        model["feature_order_matches"] = True
        for label in sorted({row["event_label"] for row in rows}):
            row = next(row for row in rows if row["event_label"] == label)
            result = lesson1_ml.predict({name: float(row[name]) for name in lesson1_ml.FEATURE_COLUMNS})
            probabilities = result.get("probabilities", {})
            if result["status"] != "OK" or result.get("prediction") not in lesson1_ml.CLASS_LABELS or abs(sum(probabilities.values()) - 1) > .001:
                model["status"] = "MODEL_VERIFICATION_FAILED"
            model["samples"].append({"dataset_label": label, "status": result["status"],
                                      "prediction": result.get("prediction"), "probabilities": probabilities})
    report["model"] = model
    return report


if __name__ == "__main__":
    result = verify_assets()
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["dataset"]["status"] == result["model"]["status"] == "VERIFIED" else 1)
