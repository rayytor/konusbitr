"""Liveness, from both ends: the heartbeat file and the HTTP probe."""

from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

import pytest

from konusbitr_worker import health


@pytest.fixture(autouse=True)
def heartbeat_in_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "nested" / "worker.heartbeat"
    monkeypatch.setenv("KONUSBITR_WORKER_HEARTBEAT", str(path))
    return path


def test_absent_heartbeat_is_not_alive() -> None:
    assert health.is_alive() is False


def test_touching_the_heartbeat_creates_its_directory() -> None:
    health.touch_heartbeat()

    assert health.heartbeat_path().is_file()
    assert health.is_alive() is True


def test_a_stale_heartbeat_is_not_alive() -> None:
    health.touch_heartbeat()
    stale = time.time() - (health.DEFAULT_MAX_AGE_SECONDS + 5)
    os.utime(health.heartbeat_path(), (stale, stale))

    assert health.is_alive() is False


# ─── The probe the container healthcheck runs ────────────────────────────────


def serve(status: int, body: dict[str, Any]) -> tuple[str, ThreadingHTTPServer]:
    """A one-response stand-in for the worker's own /health endpoint."""
    payload = json.dumps(body).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # the name BaseHTTPRequestHandler dispatches to
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args: Any) -> None:
            """Silence the default stderr access log."""

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    return f"http://{host}:{port}/health", server


def test_a_healthy_worker_exits_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    url, server = serve(200, {"ok": True, "checks": {"loop": True, "redis": True}})
    monkeypatch.setenv("KONUSBITR_WORKER_HEALTH_URL", url)
    try:
        assert health.main() == 0
    finally:
        server.shutdown()


def test_an_unhealthy_worker_exits_one_and_says_why(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """503 is what `/health` returns when the loop has stopped, and it is the
    whole reason the probe reads the body rather than only the status."""
    url, server = serve(503, {"ok": False, "checks": {"loop": False}})
    monkeypatch.setenv("KONUSBITR_WORKER_HEALTH_URL", url)
    try:
        assert health.main() == 1
    finally:
        server.shutdown()

    assert "unhealthy" in capsys.readouterr().err


def test_a_worker_that_is_not_listening_is_unhealthy(monkeypatch: pytest.MonkeyPatch) -> None:
    # Port 1 on loopback: nothing is there, and the connection is refused
    # immediately rather than timing the test out.
    monkeypatch.setenv("KONUSBITR_WORKER_HEALTH_URL", "http://127.0.0.1:1/health")

    healthy, detail = health.probe()

    assert healthy is False
    assert "not answering" in detail


def test_the_probe_url_follows_worker_port(monkeypatch: pytest.MonkeyPatch) -> None:
    """Read from the environment, not from `Settings`.

    A healthcheck must not fail because some unrelated variable is missing, or
    a container with a bad `S3_BUCKET` would report itself unhealthy instead of
    reporting the real error in its logs.
    """
    monkeypatch.delenv("KONUSBITR_WORKER_HEALTH_URL", raising=False)
    monkeypatch.setenv("WORKER_PORT", "9999")

    assert health.health_url() == "http://127.0.0.1:9999/health"
