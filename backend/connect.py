"""Connect the current folder to NexMind (works from any folder, no install needed):  python <path>/connect.py ."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nexmind.connect_client import main  # noqa: E402

raise SystemExit(main(sys.argv[1:]))
