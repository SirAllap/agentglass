import unittest
from unittest import mock

import install_hooks


class HookPythonTests(unittest.TestCase):
    def test_windows_py_launcher_selects_python_3_explicitly(self):
        with mock.patch.object(install_hooks.os, "name", "nt"), mock.patch.object(
            install_hooks.shutil, "which", side_effect=lambda name: name == "py"
        ):
            self.assertEqual("py -3", install_hooks._hook_python())


if __name__ == "__main__":
    unittest.main()
