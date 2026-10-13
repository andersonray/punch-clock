"""Make the pure ``logic`` package importable without importing Home Assistant.

``custom_components/punch_clock/__init__.py`` imports Home Assistant, so these
tests put the integration directory itself on sys.path and import ``logic`` as a
top-level package.
"""

import sys
from pathlib import Path

INTEGRATION_DIR = Path(__file__).resolve().parents[2] / "custom_components" / "punch_clock"
if str(INTEGRATION_DIR) not in sys.path:
    sys.path.insert(0, str(INTEGRATION_DIR))
