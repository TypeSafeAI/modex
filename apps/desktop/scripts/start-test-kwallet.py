"""Exec the owned KWallet 5 daemon using its real PAM key/FD handoff."""
import os
from pathlib import Path
import shutil
import socket
import sys

assert sys.platform == "linux"
assert os.environ.get("GITHUB_ACTIONS") == "true"
assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
root = Path(sys.argv[1]).resolve(strict=True)
assert root.is_relative_to(Path(os.environ["RUNNER_TEMP"]).resolve(strict=True))
daemon = shutil.which("kwalletd5")
assert daemon and Path(daemon).is_absolute()
# KDE v5.115.0 PBKDF2_SHA512_KEYSIZE. Generated in memory by the parent, never logged.
key = sys.stdin.buffer.read(57)
assert len(key) == 56
read_fd, write_fd = os.pipe()
assert os.write(write_fd, key) == len(key)
os.close(write_fd)
os.set_inheritable(read_fd, True)
listener = socket.socket(socket.AF_UNIX)
address = root / "pam.sock"
listener.bind(str(address))
listener.listen(1)
os.set_inheritable(listener.fileno(), True)
# The environment is already inherited; an empty connection completes that handoff.
peer = socket.socket(socket.AF_UNIX)
peer.connect(str(address))
peer.close()
os.environ["PAM_KWALLET5_LOGIN"] = "1"
os.execve(daemon, [daemon, "--pam-login", str(read_fd), str(listener.fileno())], os.environ)
