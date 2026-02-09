#!/usr/bin/env python3
"""
Install numba stub as a real package in the venv
This ensures it's available in all contexts (including uvicorn workers)
"""
import sys
import os
import shutil
from pathlib import Path

def install_numba_stub():
    """Install numba_stub.py as the numba package"""
    # Get the site-packages directory
    site_packages = None
    for path in sys.path:
        if 'site-packages' in path and path.endswith('site-packages'):
            site_packages = Path(path)
            break

    if not site_packages:
        print("❌ Could not find site-packages directory")
        return False

    print(f"📂 site-packages: {site_packages}")

    # Source and destination
    stub_source = Path(__file__).parent / 'numba_stub.py'
    numba_dest = site_packages / 'numba'

    if not stub_source.exists():
        print(f"❌ Stub source not found: {stub_source}")
        return False

    # Remove existing numba if it exists (should not exist)
    if numba_dest.exists():
        print(f"⚠️  Removing existing numba at {numba_dest}")
        if numba_dest.is_dir():
            shutil.rmtree(numba_dest)
        else:
            numba_dest.unlink()

    # Create numba package directory
    numba_dest.mkdir(parents=True, exist_ok=True)

    # Copy stub as __init__.py
    init_dest = numba_dest / '__init__.py'
    shutil.copy(stub_source, init_dest)

    print(f"✅ Installed numba stub: {init_dest}")

    # Verify import works
    try:
        import numba
        print("✅ numba stub can be imported")
        print(f"   numba.jit: {numba.jit}")
        print(f"   numba.types: {numba.types}")
        return True
    except Exception as e:
        print(f"❌ Failed to import numba stub: {e}")
        return False

if __name__ == '__main__':
    success = install_numba_stub()
    sys.exit(0 if success else 1)
