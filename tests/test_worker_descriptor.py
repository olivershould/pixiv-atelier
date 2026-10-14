"""Descriptor extraction tests; no browser connection or model download."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tagger"))
sys.path.insert(0, str(ROOT / ".runtime" / "tagger"))
import numpy as np
import worker


def message(field, value):
    return worker._message(field, value)


def fake_model(node_type="ReduceMean", node_name=worker.DESCRIPTOR_NODE):
    node = message(2, node_name.encode()) + message(4, node_type.encode())
    graph = message(1, node) + message(12, message(1, b"output"))
    # These envelope fields stand in for original model metadata and must survive.
    prefix = worker._integer(1, 8)
    suffix = message(2, b"unchanged-producer")
    return prefix + message(7, graph) + suffix, graph, prefix, suffix


class DescriptorGraphTests(unittest.TestCase):
    def test_adds_one_output_and_preserves_original_graph_and_metadata(self):
        raw, graph, prefix, suffix = fake_model()
        augmented = worker.with_descriptor_output(raw)
        self.assertTrue(augmented.startswith(prefix))
        self.assertTrue(augmented.endswith(suffix))
        span = next(span for span in worker._protobuf_fields(augmented) if span[0] == 7)
        updated_graph = augmented[span[3]:span[4]]
        self.assertEqual(updated_graph[:len(graph)], graph)
        outputs = [span for span in worker._protobuf_fields(updated_graph) if span[0] == 12]
        self.assertEqual(len(outputs), 2)
        self.assertEqual(raw, prefix + message(7, graph) + suffix)

    def test_missing_or_wrong_pool_and_existing_output_are_rejected(self):
        for raw in (fake_model(node_type="Add")[0], fake_model(node_name="other")[0]):
            with self.assertRaises(ValueError):
                worker.with_descriptor_output(raw)
        with self.assertRaises(ValueError):
            worker.with_descriptor_output(worker.with_descriptor_output(fake_model()[0]))

    def test_truncated_and_oversized_fields_are_rejected(self):
        for raw in (b"\x3a\x80", b"\x3a\x05x", b"\x00", b"\x3a" + b"\xff" * 10):
            with self.assertRaises(ValueError):
                worker.with_descriptor_output(raw)


class FakeSession:
    def __init__(self, feature, fail_feature=False):
        self.feature = feature
        self.fail_feature = fail_feature
        self.calls = []

    def run(self, outputs, inputs):
        self.calls.append(outputs)
        if len(outputs) == 2 and self.fail_feature:
            raise RuntimeError("Optional feature cannot be fetched")
        scores = np.array([[.94]], dtype=np.float32)
        return [scores, self.feature] if len(outputs) == 2 else [scores]


class DescriptorInferenceTests(unittest.TestCase):
    def predictor(self, feature, fail_feature=False):
        predictor = worker.Predictor()
        predictor.initialize = lambda: None
        predictor.np = np
        predictor.session = FakeSession(feature, fail_feature)
        predictor.model_sha256 = worker.DESCRIPTOR_MODEL_SHA256
        predictor.input_name, predictor.output_name = "input", "output"
        predictor.descriptor_name = worker.DESCRIPTOR_NODE
        predictor.labels = [("1girl", 0)]
        predictor.prepare = lambda file: (np.zeros((1, 1, 1, 3)), {"id": file["id"], "sha256": "a" * 64})
        return predictor

    def test_classification_and_unit_descriptor_share_one_inference(self):
        predictor = self.predictor(np.ones((1, 1024), dtype=np.float32))
        result = predictor.analyze([{"id": "one"}])
        self.assertEqual(len(predictor.session.calls), 1)
        self.assertEqual(len(predictor.session.calls[0]), 2)
        descriptor = result["analyzedFiles"][0]["descriptor"]
        self.assertEqual(descriptor["version"], worker.DESCRIPTOR_VERSION)
        self.assertEqual(descriptor["modelSha256"], worker.DESCRIPTOR_MODEL_SHA256)
        self.assertEqual(len(descriptor["values"]), 1024)
        self.assertAlmostEqual(sum(value * value for value in descriptor["values"]), 1)
        self.assertEqual(result["predictions"][0]["name"], "1girl")

    def test_feature_fetch_failure_keeps_classification_and_disables_retries(self):
        predictor = self.predictor(None, fail_feature=True)
        result = predictor.analyze([{"id": "one"}, {"id": "two"}])
        self.assertEqual([len(call) for call in predictor.session.calls], [2, 1, 1])
        self.assertIsNone(predictor.descriptor_name)
        self.assertTrue(all("descriptor" not in file for file in result["analyzedFiles"]))
        self.assertEqual(len(result["predictions"]), 2)

    def test_invalid_features_do_not_discard_classification(self):
        for feature in (np.zeros((1, 1024)), np.full((1, 1024), np.nan), np.full((1, 1024), np.inf), np.ones((1, 8))):
            predictor = self.predictor(feature)
            result = predictor.analyze([{"id": "one"}])
            self.assertNotIn("descriptor", result["analyzedFiles"][0])
            self.assertEqual(result["predictions"][0]["name"], "1girl")


if __name__ == "__main__":
    unittest.main()
