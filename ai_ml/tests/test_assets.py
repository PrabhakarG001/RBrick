import pytest
from ai_ml import lesson1_ml
from ai_ml.inference.model_loader import ModelLoader


def test_arbitrary_weight_file_does_not_report_loaded(tmp_path):
    (tmp_path / 'untrusted.joblib').write_bytes(b'not a trusted model')
    status = ModelLoader(tmp_path).discover_and_load()
    assert status['loaded'] is False
    assert status['status'] == 'MODEL_VERIFICATION_FAILED'


def test_tampered_model_is_rejected_before_deserialization(tmp_path, monkeypatch):
    artifact = tmp_path / 'iot_sensor_model.joblib'
    artifact.write_bytes(b'not a trusted model')
    monkeypatch.setattr(lesson1_ml, 'MODEL_PATHS', (artifact,))
    result = lesson1_ml.load_model_bundle(force_reload=True)
    assert result['available'] is False
    assert result['status'] == 'MODEL_VERIFICATION_FAILED'


def test_preserved_classifier_and_dataset():
    pytest.importorskip('sklearn')
    pytest.importorskip('pandas')
    from ai_ml.verify_assets import verify_assets
    result = verify_assets()
    assert result['dataset']['status'] == 'VERIFIED'
    assert result['dataset']['rows'] == 1250
    assert result['model']['status'] == 'VERIFIED'
    assert result['model']['type'] == 'RandomForestClassifier'
    assert len(result['model']['samples']) == 5


def test_default_loader_uses_package_path_and_actual_model(tmp_path, monkeypatch):
    pytest.importorskip('sklearn')
    pytest.importorskip('pandas')
    monkeypatch.chdir(tmp_path)
    loader = ModelLoader()
    status = loader.discover_and_load()
    assert status['loaded'] is True
    assert status['status'] == 'VERIFIED'
    assert loader.loaded_model.n_features_in_ == 7
