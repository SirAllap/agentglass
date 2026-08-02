import os
import subprocess
import tempfile
import unittest
from unittest import mock

import install_hooks


def _git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class ForwarderPathTests(unittest.TestCase):
    def test_worktree_install_points_at_the_main_clone(self):
        """A worktree is disposable; the path we bake into settings must not be."""
        with tempfile.TemporaryDirectory() as tmp:
            main = os.path.join(tmp, "main")
            os.makedirs(os.path.join(main, "hooks"))
            open(os.path.join(main, "hooks", "send_event.py"), "w").close()
            _git(tmp, "init", "-q", "main")
            _git(main, "-c", "user.email=t@t", "-c", "user.name=t",
                 "add", "-A")
            _git(main, "-c", "user.email=t@t", "-c", "user.name=t",
                 "commit", "-qm", "init")
            wt = os.path.join(tmp, "wt")
            _git(main, "worktree", "add", "-q", "-b", "side", wt)

            resolved = install_hooks.forwarder_path(os.path.join(wt, "hooks"))
            self.assertEqual(
                os.path.realpath(os.path.join(main, "hooks", "send_event.py")),
                os.path.realpath(resolved),
            )

    def test_plain_directory_falls_back_to_its_own_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(os.path.join(tmp, "send_event.py"),
                             install_hooks.forwarder_path(tmp))


class HookCommandTests(unittest.TestCase):
    def test_command_fails_open_so_a_dead_forwarder_cannot_block_tools(self):
        cmd = install_hooks._hook_command("python3", "/x/send_event.py", "PreToolUse", False)
        self.assertTrue(cmd.endswith(" || exit 0"), cmd)

    def test_command_fails_open_on_windows_too(self):
        with mock.patch.object(install_hooks.os, "name", "nt"):
            cmd = install_hooks._hook_command("py -3", "C:\\x\\send_event.py", "Stop", True)
        self.assertTrue(cmd.endswith(" --add-usage || exit /b 0"), cmd)

    def test_installed_commands_are_still_recognised_as_ours(self):
        cfg = {}
        install_hooks.do_install(cfg, "/x/send_event.py")
        install_hooks.do_uninstall(cfg)
        self.assertEqual({}, cfg)


class HookPythonTests(unittest.TestCase):
    def test_windows_py_launcher_selects_python_3_explicitly(self):
        with mock.patch.object(install_hooks.os, "name", "nt"), mock.patch.object(
            install_hooks.shutil, "which", side_effect=lambda name: name == "py"
        ):
            self.assertEqual("py -3", install_hooks._hook_python())


if __name__ == "__main__":
    unittest.main()
