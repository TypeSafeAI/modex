import os
from pathlib import Path
import subprocess
import sys


def incomplete():
    print("token-check-incomplete", file=sys.stderr)
    raise SystemExit(2)


try:
    result = subprocess.run(["gh", "auth", "token", "--hostname", "github.com"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    token = result.stdout.strip()
    if result.returncode or not token or b"\n" in token or b"\r" in token or not sys.argv[1:]:
        incomplete()
    files = []
    for value in sys.argv[1:]:
        root = Path(value)
        if root.is_symlink() or not root.exists():
            incomplete()
        if root.is_dir():
            def walk_error(error):
                raise error
            for directory, directories, names in os.walk(root, onerror=walk_error):
                for name in directories + names:
                    if (Path(directory) / name).is_symlink():
                        incomplete()
                files.extend(Path(directory) / name for name in names)
        elif root.is_file():
            files.append(root)
        else:
            incomplete()
    found = False
    for path in files:
        if not path.is_file():
            incomplete()
        found = token in path.read_bytes() or found
except OSError:
    incomplete()

print("TOKEN-FOUND" if found else "token-absent")
raise SystemExit(1 if found else 0)
