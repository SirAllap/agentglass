import importlib
import io
import json
import os
import tempfile
import time
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

    def test_localhost_is_rewritten_to_ipv4_loopback(self):
        # The server binds IPv4-only; resolving `localhost` can try ::1 first
        # and pay a multi-second refused connect on some hosts.
        self.assertEqual(
            send_event._agentglass_local_only("http://localhost:4000"),
            "http://127.0.0.1:4000",
        )

    def test_explicit_ipv4_loopback_is_untouched(self):
        self.assertEqual(
            send_event._agentglass_local_only("http://127.0.0.1:4000"),
            "http://127.0.0.1:4000",
        )

    def test_default_server_avoids_localhost(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AGENTGLASS_SERVER", None)
            importlib.reload(send_event)
        self.assertNotIn("localhost", send_event.DEFAULT_SERVER)


class BreakerTests(unittest.TestCase):
    """A recent failed send short-circuits the hook so a down server never
    stalls tool calls; a stale marker lets sends resume."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        patcher = unittest.mock.patch.object(
            send_event.tempfile, "gettempdir", return_value=self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run_main(self, marker_age_s):
        marker = send_event._marker_path()
        with open(marker, "w"):
            pass
        os.utime(marker, (time.time() - marker_age_s,) * 2)
        stdin = io.StringIO('{"session_id":"s1","hook_event_name":"PostToolUse"}')
        with unittest.mock.patch.object(send_event.sys, "argv",
                                        ["send_event.py", "--event-type", "PostToolUse"]), \
             unittest.mock.patch.object(send_event.sys, "stdin", stdin), \
             unittest.mock.patch.object(send_event, "spawn_detached") as spawn:
            try:
                send_event.main()
            except SystemExit:
                pass
        return stdin, spawn

    def test_fresh_marker_skips_the_spawn_and_drains_stdin(self):
        stdin, spawn = self._run_main(marker_age_s=0)
        spawn.assert_not_called()
        self.assertEqual(stdin.read(), "")  # stdin was consumed

    def test_stale_marker_spawns_the_detached_send(self):
        _, spawn = self._run_main(marker_age_s=send_event.BREAKER_TTL_S + 5)
        spawn.assert_called_once()


class SendDetachedTests(unittest.TestCase):
    """The detached child deletes its payload file and maintains the marker."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        patcher = unittest.mock.patch.object(
            send_event.tempfile, "gettempdir", return_value=self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.payload = os.path.join(self.tmp, send_event.PAYLOAD_PREFIX + "t.json")
        with open(self.payload, "w") as f:
            f.write("{}")

    def test_success_deletes_payload_and_clears_marker(self):
        with open(send_event._marker_path(), "w"):
            pass
        with unittest.mock.patch.object(send_event.urllib.request, "urlopen",
                                        return_value=unittest.mock.MagicMock()):
            send_event.send_detached(self.payload, "http://127.0.0.1:4000")
        self.assertFalse(os.path.exists(self.payload))
        self.assertFalse(os.path.exists(send_event._marker_path()))

    def test_failure_deletes_payload_and_touches_marker(self):
        with unittest.mock.patch.object(send_event.urllib.request, "urlopen",
                                        side_effect=OSError("refused")):
            send_event.send_detached(self.payload, "http://127.0.0.1:4000")
        self.assertFalse(os.path.exists(self.payload))
        self.assertTrue(os.path.exists(send_event._marker_path()))
        self.assertTrue(send_event._breaker_active())


if __name__ == "__main__":
    unittest.main()
