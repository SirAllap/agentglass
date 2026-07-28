import json
import os
import tempfile
import unittest
import unittest.mock

import send_event


class LatestUsageTests(unittest.TestCase):
    def test_reads_only_the_latest_assistant_usage(self):
        rows = [
            {"type": "assistant", "message": {"model": "old", "usage": {"input_tokens": 1, "output_tokens": 2}}},
            {"type": "user", "message": {"content": "hello"}},
            {"type": "assistant", "message": {"model": "new", "usage": {"input_tokens": 3, "output_tokens": 4}}},
        ]
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
            path = f.name
        try:
            usage, model = send_event.read_latest_usage(path)
            self.assertEqual(usage, {"input_tokens": 3, "output_tokens": 4})
            self.assertEqual(model, "new")
        finally:
            os.unlink(path)

    def test_skips_an_incomplete_final_record(self):
        row = {"type": "assistant", "message": {"model": "ok", "usage": {"input_tokens": 5}}}
        with tempfile.NamedTemporaryFile("wb", delete=False) as f:
            f.write((json.dumps(row) + "\n").encode("utf-8"))
            f.write(b'{"type":"assistant"')
            path = f.name
        try:
            usage, model = send_event.read_latest_usage(path)
            self.assertEqual(usage, {"input_tokens": 5})
            self.assertEqual(model, "ok")
        finally:
            os.unlink(path)


class LocalOnlyGuardTests(unittest.TestCase):
    """The guard that keeps full session content on this machine.

    AGENTGLASS_SERVER is attacker-influenceable (a cloned repo's settings.json
    can set it), so only the literal "1" may switch the guard off — a truthy
    test made AGENTGLASS_ALLOW_REMOTE=0 read as "allow remote".
    """

    def _refuses(self, env):
        with unittest.mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(SystemExit):
                send_event._agentglass_local_only("https://evil.example.com")

    def test_refuses_a_remote_server_by_default(self):
        os.environ.pop("AGENTGLASS_ALLOW_REMOTE", None)
        self._refuses({})

    def test_falsey_opt_in_values_do_not_disable_the_guard(self):
        for value in ("0", "false", "no", ""):
            with self.subTest(value=value):
                self._refuses({"AGENTGLASS_ALLOW_REMOTE": value})

    def test_explicit_one_allows_a_remote_server(self):
        with unittest.mock.patch.dict(os.environ, {"AGENTGLASS_ALLOW_REMOTE": "1"}, clear=False):
            send_event._agentglass_local_only("https://evil.example.com")  # no SystemExit

    def test_local_servers_are_always_allowed(self):
        for url in ("http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000"):
            with self.subTest(url=url):
                send_event._agentglass_local_only(url)


if __name__ == "__main__":
    unittest.main()
