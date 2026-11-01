"""Synthetic-only regression checks; never invoke the signed-in gh executable."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("code-review-token-check.py")
TOKEN = "synthetic-review-token-not-a-credential"


class TokenCheck(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.gh = self.bin / "gh"
        self.gh.write_text('#!/bin/sh\n[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] || exit 9\n[ "$FAKE_AUTH_FAIL" = 1 ] && exit 1\nprintf "%s" "$FAKE_TOKEN"\n')
        self.gh.chmod(0o700)
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()
        (self.evidence / "result.txt").write_text("clean fixture result")
        self.env = {**os.environ, "PATH": str(self.bin), "FAKE_TOKEN": TOKEN, "FAKE_AUTH_FAIL": "0"}

    def check(self, expected, *paths):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, paths)], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        if expected == 2:
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr.strip(), "token-check-incomplete")
        else:
            self.assertEqual(result.stdout.strip(), "TOKEN-FOUND" if expected else "token-absent")

    def test_clean_complete_evidence(self):
        self.check(0, self.evidence)

    def test_token_in_nested_evidence(self):
        nested = self.evidence / "nested"
        nested.mkdir()
        (nested / "log").write_text("prefix " + TOKEN + " suffix")
        self.check(1, self.evidence)

    def test_failed_authentication(self):
        self.env["FAKE_AUTH_FAIL"] = "1"
        self.check(2, self.evidence)

    def test_empty_token(self):
        self.env["FAKE_TOKEN"] = ""
        self.check(2, self.evidence)

    def test_missing_required_evidence(self):
        self.check(2, self.evidence, self.root / "missing")

    def test_symlink_is_not_clean_evidence(self):
        (self.evidence / "link").symlink_to(self.evidence / "result.txt")
        self.check(2, self.evidence)

    def test_unreadable_file(self):
        file = self.evidence / "result.txt"
        file.chmod(0)
        try:
            self.check(2, self.evidence)
        finally:
            file.chmod(0o600)

    def test_missing_gh(self):
        self.gh.unlink()
        self.check(2, self.evidence)

    def test_no_required_paths(self):
        self.check(2)


if __name__ == "__main__":
    unittest.main()
