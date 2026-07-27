import json
import os
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
