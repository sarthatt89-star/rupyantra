"""Command-line door: reads ONE JSON request from stdin, prints ONE JSON answer.

    echo '{"function":"describe_series","args":{"values":[1,2,3]}}' | python3 run.py

Used by tests and by local development (lib/python-bridge.js with RY_PYTHON). Production traffic goes through server.py.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src import engine  # noqa: E402


def main():
    text = sys.stdin.read(engine.MAX_REQUEST_BYTES + 1)
    sys.stdout.write(engine.execute_json(text) + "\n")


if __name__ == "__main__":
    main()
