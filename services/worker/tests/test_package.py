"""Smoke tests: the package imports and the test runner is wired up.

Real pipeline tests arrive with Phase 06.
"""

import sys

import konusbitr_worker


def test_package_exposes_a_version() -> None:
    assert isinstance(konusbitr_worker.__version__, str)
    assert konusbitr_worker.__version__


def test_runs_on_python_312() -> None:
    assert sys.version_info[:2] == (3, 12)
