from concurrent.futures import ThreadPoolExecutor
import time

from backend.models import depth_model as depth_model_module


def test_cold_model_initialization_is_single_flight(monkeypatch) -> None:
    class FakeModel:
        def to(self, _device):
            return self

        def eval(self):
            return self

    class FakeDepthAnything3:
        calls = 0
        instance = FakeModel()

        @classmethod
        def from_pretrained(cls, _model_id, *, cache_dir):
            assert cache_dir
            cls.calls += 1
            # Keep the first caller inside construction long enough for the
            # other workers to exercise the cold-start race.
            time.sleep(0.03)
            return cls.instance

    monkeypatch.setattr(depth_model_module, "DepthAnything3", FakeDepthAnything3)
    model = depth_model_module.DepthModel(model_id="test/model", device="cpu")

    with ThreadPoolExecutor(max_workers=3) as executor:
        instances = list(executor.map(lambda _: model._ensure_model(), range(3)))

    assert FakeDepthAnything3.calls == 1
    assert all(instance is FakeDepthAnything3.instance for instance in instances)
