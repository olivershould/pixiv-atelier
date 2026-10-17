"""Portable tagger configuration tests; no model load, installation or download."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parent.parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, PROJECT / "tagger" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


setup = load_module("portable_tagger_setup", "setup.py")
worker = load_module("portable_tagger_worker", "worker.py")


class PortableTaggerPaths(unittest.TestCase):
    def test_setup_saves_project_paths_without_binding_them_to_a_machine(self):
        with tempfile.TemporaryDirectory(prefix="atelier-paths-") as temporary:
            root = Path(temporary).resolve()
            with patch.object(setup, "ROOT", root), patch.object(setup, "RUNTIME", root / ".runtime/tagger"), patch.object(setup, "MODELS", root / ".data/models/wd-swinv2-v3"), patch.object(sys, "executable", str(root / ".runtime/python/python.exe")):
                result = setup.build_configuration({"modelVersion": "kept-revision"})
                self.assertEqual(result["pythonPath"], ".runtime/python/python.exe")
                self.assertEqual(result["runtimeDir"], ".runtime/tagger")
                self.assertEqual(result["modelDir"], ".data/models/wd-swinv2-v3")
                self.assertEqual(result["modelRevision"], "kept-revision")
                self.assertEqual(setup.configuration_path(".runtime/with spaces/python.exe"), ".runtime/with spaces/python.exe")

    def test_explicit_external_python_path_stays_absolute(self):
        with tempfile.TemporaryDirectory(prefix="atelier-paths-") as temporary:
            root = Path(temporary).resolve() / "project"
            external = root.parent / "independent-python/python.exe"
            with patch.object(setup, "ROOT", root):
                self.assertEqual(setup.configuration_path(external), str(external))

    def test_worker_relative_environment_paths_use_its_project_root(self):
        with tempfile.TemporaryDirectory(prefix="atelier-paths-") as temporary:
            root = Path(temporary).resolve()
            with patch.object(worker, "ROOT", root), patch.dict(os.environ, {"TAGGER_RUNTIME": ".runtime/tagger", "TAGGER_MODEL_DIR": ".data/models/wd-swinv2-v3"}):
                self.assertEqual(worker.configured_path("TAGGER_RUNTIME", root / "unused"), root / ".runtime/tagger")
                self.assertEqual(worker.configured_path("TAGGER_MODEL_DIR", root / "unused"), root / ".data/models/wd-swinv2-v3")
                with patch.dict(os.environ, {"TAGGER_RUNTIME": str(root.parent / "external-runtime")}):
                    self.assertEqual(worker.configured_path("TAGGER_RUNTIME", root / "unused"), root.parent / "external-runtime")

    def test_setup_without_flags_still_performs_no_download_or_configuration_write(self):
        with patch.object(sys, "argv", ["setup.py"]), patch.object(setup, "install_dependencies") as install, patch.object(setup, "download_file") as download, patch.object(setup, "verify") as verify, patch.object(setup, "atomic_json") as save, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.main(), 0)
            install.assert_not_called()
            download.assert_not_called()
            verify.assert_not_called()
            save.assert_not_called()
            self.assertIn("No downloads or installation performed", output.getvalue())

    def test_missing_pip_can_only_bootstrap_the_project_owned_python(self):
        with tempfile.TemporaryDirectory(prefix="atelier-paths-") as temporary:
            root = Path(temporary).resolve()
            with patch.object(setup, "ROOT", root), patch.object(sys, "executable", str(root / ".runtime/python/python.exe")), patch.object(setup.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0)]) as run:
                setup.ensure_pip()
                self.assertEqual(len(run.call_args_list), 2)
                self.assertEqual(run.call_args_list[1].args[0][1:], ["-I", "-m", "ensurepip", "--default-pip"])
            with patch.object(setup, "ROOT", root), patch.object(sys, "executable", str(root.parent / "external-python/python.exe")), patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)) as run:
                with self.assertRaisesRegex(RuntimeError, "no pip"):
                    setup.ensure_pip()
                self.assertEqual(run.call_count, 1)

    def test_existing_pip_is_reused_without_installation(self):
        with patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            setup.ensure_pip()
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
