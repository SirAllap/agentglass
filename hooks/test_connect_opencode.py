import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from hooks import connect_opencode


class ConnectOpenCodeTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.config_dir = self.root / "opencode"
        self.plugin_source = self.root / "agentglass.js"
        self.plugin_source.write_text(
            "// agentglass opencode plugin\n"
            "export const AgentGlassPlugin = async () => ({});\n"
        )

        self.config_patch = patch.object(
            connect_opencode, "_opencode_config_dir", return_value=self.config_dir
        )
        self.source_patch = patch.object(
            connect_opencode, "PLUGIN_SRC", self.plugin_source
        )
        self.config_patch.start()
        self.source_patch.start()
        self.addCleanup(self.config_patch.stop)
        self.addCleanup(self.source_patch.stop)

    def test_install_does_not_modify_opencode_package(self):
        self.config_dir.mkdir(parents=True)
        package_path = self.config_dir / "package.json"
        package_path.write_text("not valid json\n")

        self.assertTrue(connect_opencode.wire_plugin(False))

        self.assertEqual(package_path.read_text(), "not valid json\n")
        self.assertEqual(
            (self.config_dir / "plugins" / "agentglass.js").read_text(),
            self.plugin_source.read_text(),
        )

    def test_repeated_install_is_idempotent(self):
        self.assertTrue(connect_opencode.wire_plugin(False))
        self.assertTrue(connect_opencode.wire_plugin(False))

        self.assertFalse((self.config_dir / "package.json").exists())
        self.assertEqual(
            (self.config_dir / "plugins" / "agentglass.js").read_text(),
            self.plugin_source.read_text(),
        )

    def test_undo_removes_only_the_plugin(self):
        package_path = self.config_dir / "package.json"
        package_path.parent.mkdir(parents=True)
        package_path.write_text('{"dependencies":{"user-package":"1.0.0"}}\n')
        connect_opencode.wire_plugin(False)

        self.assertTrue(connect_opencode.wire_plugin(True))

        self.assertFalse((self.config_dir / "plugins" / "agentglass.js").exists())
        self.assertEqual(
            package_path.read_text(),
            '{"dependencies":{"user-package":"1.0.0"}}\n',
        )

    def test_direct_setup_reports_failure(self):
        with (
            patch.object(connect_opencode, "opencode_installed", return_value=True),
            patch.object(connect_opencode, "wire_plugin", side_effect=PermissionError("denied")),
            patch.object(connect_opencode.sys, "argv", ["connect_opencode.py"]),
        ):
            self.assertEqual(connect_opencode.main(), 1)

    def test_install_refuses_unrelated_plugin_with_same_name(self):
        plugin_path = self.config_dir / "plugins" / "agentglass.js"
        plugin_path.parent.mkdir(parents=True)
        plugin_path.write_text("export const UserPlugin = async () => ({});\n")

        self.assertFalse(connect_opencode.wire_plugin(False))

        self.assertEqual(
            plugin_path.read_text(),
            "export const UserPlugin = async () => ({});\n",
        )

    def test_undo_preserves_unrelated_plugin_with_same_name(self):
        plugin_path = self.config_dir / "plugins" / "agentglass.js"
        plugin_path.parent.mkdir(parents=True)
        plugin_path.write_text("export const UserPlugin = async () => ({});\n")

        self.assertTrue(connect_opencode.wire_plugin(True))

        self.assertEqual(
            plugin_path.read_text(),
            "export const UserPlugin = async () => ({});\n",
        )

    def test_direct_setup_rejects_remote_server(self):
        with (
            patch.object(connect_opencode, "SERVER", "https://example.com"),
            patch.object(connect_opencode.sys, "argv", ["connect_opencode.py"]),
            patch.dict(connect_opencode.os.environ),
        ):
            connect_opencode.os.environ.pop("AGENTGLASS_ALLOW_REMOTE", None)
            self.assertEqual(connect_opencode.main(), 1)

    def test_remote_server_requires_explicit_one(self):
        with patch.dict(
            connect_opencode.os.environ,
            {"AGENTGLASS_ALLOW_REMOTE": "0"},
            clear=True,
        ):
            self.assertFalse(connect_opencode._agentglass_local_only("https://example.com"))

        with patch.dict(
            connect_opencode.os.environ,
            {"AGENTGLASS_ALLOW_REMOTE": "1"},
            clear=True,
        ):
            self.assertTrue(connect_opencode._agentglass_local_only("https://example.com"))

    def test_undo_ignores_remote_server_configuration(self):
        plugin_path = self.config_dir / "plugins" / "agentglass.js"
        plugin_path.parent.mkdir(parents=True)
        plugin_path.write_text(self.plugin_source.read_text())
        with (
            patch.object(connect_opencode, "SERVER", "https://example.com"),
            patch.object(connect_opencode, "opencode_installed", return_value=True),
            patch.object(connect_opencode.sys, "argv", ["connect_opencode.py", "--undo"]),
            patch.dict(connect_opencode.os.environ),
        ):
            connect_opencode.os.environ.pop("AGENTGLASS_ALLOW_REMOTE", None)
            self.assertEqual(connect_opencode.main(), 0)

        self.assertFalse(plugin_path.exists())


if __name__ == "__main__":
    unittest.main()
