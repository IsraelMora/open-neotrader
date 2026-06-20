"""
TDD tests for neurotrader_sdk.__version__ attribute.

Phase 1, Task 1.1 — RED: written before __version__ is added to __init__.py.
AC-5: import neurotrader_sdk; neurotrader_sdk.__version__ == "0.1.0"
AC-6: value matches setup.py version field
"""
from __future__ import annotations

import re
from pathlib import Path


def test_version_attribute_exists():
    """AC-5: neurotrader_sdk.__version__ must be accessible."""
    import neurotrader_sdk
    assert hasattr(neurotrader_sdk, "__version__"), (
        "__version__ attribute not found in neurotrader_sdk"
    )


def test_version_value():
    """AC-5: neurotrader_sdk.__version__ must equal '0.1.0'."""
    from neurotrader_sdk import __version__
    assert __version__ == "0.1.0", f"Expected '0.1.0', got '{__version__}'"


def test_version_in_all():
    """AC-5: __version__ must be part of __all__."""
    import neurotrader_sdk
    assert "__version__" in neurotrader_sdk.__all__, (
        "__version__ not found in neurotrader_sdk.__all__"
    )


def test_version_matches_setup_py():
    """AC-6: __version__ must match the version= string in setup.py."""
    from neurotrader_sdk import __version__

    setup_py = Path(__file__).parent.parent / "setup.py"
    content = setup_py.read_text(encoding="utf-8")
    # Match version="..." or version='...'
    m = re.search(r'version=["\']([^"\']+)["\']', content)
    assert m is not None, "Could not find version= in setup.py"
    setup_version = m.group(1)
    assert __version__ == setup_version, (
        f"neurotrader_sdk.__version__ '{__version__}' does not match "
        f"setup.py version '{setup_version}'"
    )
