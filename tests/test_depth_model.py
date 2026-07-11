from concurrent.futures import ThreadPoolExecutor
import time

from backend.models import depth_model as depth_model_module


def test_single_image_input_processor_uses_sequential_preprocessing() -> None:
    calls = []

    def delegate(image, *args, **kwargs):
        calls.append((image, args, kwargs))
        return "processed"

    processor = depth_model_module._SingleImageInputProcessor(delegate)

    assert processor(["frame"], "metadata") == "processed"
    assert calls == [(["frame"], ("metadata",), {"num_workers": 1, "sequential": True})]


def test_single_image_input_processor_preserves_batch_parallelism() -> None:
    calls = []

    def delegate(image, *args, **kwargs):
        calls.append((image, args, kwargs))

    processor = depth_model_module._SingleImageInputProcessor(delegate)

    processor(["frame-1", "frame-2"])
    assert calls == [(["frame-1", "frame-2"], (), {})]


def test_single_image_input_processor_preserves_explicit_options() -> None:
    calls = []

    def delegate(image, *args, **kwargs):
        calls.append(kwargs)

    processor = depth_model_module._SingleImageInputProcessor(delegate)

    processor(["frame"], num_workers=4, sequential=False)
    assert calls == [{"num_workers": 4, "sequential": False}]


def test_cold_model_initialization_is_single_flight(monkeypatch) -> None:
    class FakeModel:
        def __init__(self):
            self.input_processor = lambda image, *args, **kwargs: image

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
    assert isinstance(
        FakeDepthAnything3.instance.input_processor,
        depth_model_module._SingleImageInputProcessor,
    )
