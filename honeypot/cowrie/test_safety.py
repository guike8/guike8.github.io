"""Run inside the image: python /opt/observatory/test_safety.py."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from cowrie.output.observatory import Output, sanitize
from cowrie.core.config import CowrieConfig
from safe_logger import observer
from twisted.logger import LogLevel


class SafetyTests(unittest.TestCase):
    def test_password_and_rendered_message_are_not_persisted(self):
        event = {"eventid": "cowrie.login.failed", "timestamp": "2026-11-11T12:00:00Z", "session": "test", "src_ip": "203.0.113.1", "username": "root", "password": "never-store-me", "message": "root/never-store-me failed", "nested": {"password": "never-store-me"}}
        result = sanitize(event)
        serialized = json.dumps(result)
        self.assertNotIn("never-store-me", serialized)
        self.assertNotIn('"password"', serialized)
        self.assertTrue(result["credential_attempt"])
        self.assertEqual(result["username"], "root")

    def test_command_redaction_and_limits(self):
        event = {"eventid": "cowrie.command.input", "input": "curl https://user:private@example.invalid/a?token=secret&x=abc password=hidden\x1b" + "a" * 4000, "session": "a" * 1000}
        result = sanitize(event)
        self.assertLessEqual(len(result["input"]), 1024)
        self.assertLessEqual(len(result["session"]), 64)
        for secret in ("private", "secret", "hidden", "\x1b"):
            self.assertNotIn(secret, result["input"])

    def test_unknown_events_are_not_saved(self):
        self.assertIsNone(sanitize({"eventid": "other", "message": "private"}))

    def test_logger_drops_attacker_messages(self):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            observer()({"log_level": LogLevel.error, "log_namespace": "cowrie.test", "log_format": "private", "message": "never-store-me", "password": "never-store-me"})
        self.assertNotIn("never-store-me", stream.getvalue())
        self.assertNotIn("private", stream.getvalue())

    def test_bounded_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            CowrieConfig.set("output_observatory", "logfile", str(Path(directory) / "events.json"))
            CowrieConfig.set("output_observatory", "max_bytes", "256")
            CowrieConfig.set("output_observatory", "backups", "2")
            plugin = Output()
            for i in range(20):
                plugin.write({"eventid": "cowrie.command.input", "session": "abc", "input": "a" * 100})
            plugin.stop()
            files = list(Path(directory).iterdir())
            self.assertLessEqual(len(files), 3)
            self.assertTrue(all(path.stat().st_size < 512 for path in files))
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in files))
            for path in files:
                for line in path.read_text().splitlines():
                    json.loads(line)


if __name__ == "__main__":
    unittest.main()
