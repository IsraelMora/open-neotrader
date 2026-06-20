from setuptools import find_packages, setup

setup(
    name="neurotrader-sdk",
    version="0.1.0",  # Must match __init__.__version__
    packages=find_packages(),
    python_requires=">=3.11",
    description="SDK para plugins de la plataforma NeuroTrader",
)
