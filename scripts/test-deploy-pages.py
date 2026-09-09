#!/usr/bin/env python3
"""Unit tests for the direct GitHub Pages deployment client."""

from __future__ import annotations

import contextlib
from http.client import IncompleteRead
import importlib.util
import io
import json
import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("deploy_pages", ROOT / "scripts" / "deploy-pages.py")
assert SPEC is not None and SPEC.loader is not None
deploy_pages = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy_pages)


class Response:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self.body = body
        self.closed = False

    def getcode(self) -> int:
        return self.status

    def read(self) -> bytes:
        return self.body

    def close(self) -> None:
        self.closed = True


class PartialResponse(Response):
    def read(self) -> bytes:
        raise IncompleteRead(self.body, len(self.body) + 1)


class SignalResponse(Response):
    def read(self) -> bytes:
        os.kill(os.getpid(), signal.SIGTERM)
        return self.body


class CloseFailureResponse(Response):
    def close(self) -> None:
        raise OSError("close failed")


class TrackingHTTPError(HTTPError):
    def __init__(self, body: bytes) -> None:
        super().__init__("https://api.github.com/test", 500, "failure", {}, io.BytesIO(body))
        self.closed = False

    def close(self) -> None:
        self.closed = True
        super().close()


class OpenSequence:
    def __init__(self, responses: list[Response | HTTPError]) -> None:
        self.responses = iter(responses)
        self.requests = []

    def __call__(self, request, *, timeout: int):
        self.requests.append(request)
        result = next(self.responses)
        if isinstance(result, BaseException):
            raise result
        return result


def response(status: int, value: object) -> Response:
    return Response(status, json.dumps(value, separators=(",", ":")).encode())


def http_error(status: int, body: bytes) -> HTTPError:
    return HTTPError("https://api.github.com/test", status, "failure", {}, io.BytesIO(body))


class DeployPagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        configured_root = os.environ.get("HARNESS_ARTIFACTS_ROOT")
        cls.artifact_root = Path(
            tempfile.mkdtemp(prefix="pages-deploy-unit-", dir=configured_root or None)
        )
        print(f"Pages deployment test evidence retained at {cls.artifact_root}", file=sys.stderr)

    @classmethod
    def tearDownClass(cls) -> None:
        print(f"Pages deployment test evidence remains at {cls.artifact_root}", file=sys.stderr)

    def setUp(self) -> None:
        self.output = self.artifact_root / f"{self._testMethodName}.output"
        self.log = self.artifact_root / f"{self._testMethodName}.stderr"
        self.output.write_text("")
        self.environment = {
            "PAGES_ARTIFACT_ID": "123",
            "PAGES_BUILD_VERSION": "a" * 40,
            "GITHUB_REPOSITORY": "TeleCrypt-io/storage.telecrypt.io",
            "GH_TOKEN": "gh-secret-token",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://token.actions.githubusercontent.com/?x=1",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "oidc-request-secret",
            "GITHUB_OUTPUT": str(self.output),
        }

    def run_deploy(self, opener: OpenSequence, *, clock=None, sleep=None) -> str:
        kwargs = {}
        if clock is not None:
            kwargs["clock"] = clock
        if sleep is not None:
            kwargs["sleep"] = sleep
        with patch.dict(os.environ, self.environment, clear=True), patch.object(deploy_pages, "urlopen", opener):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                try:
                    deploy_pages.deploy(**kwargs)
                except BaseException:
                    self.log.write_text(stderr.getvalue())
                    raise
            self.log.write_text(stderr.getvalue())
            return stderr.getvalue()

    def run_deploy_error(self, opener: OpenSequence, *, clock=None, sleep=None):
        kwargs = {}
        if clock is not None:
            kwargs["clock"] = clock
        if sleep is not None:
            kwargs["sleep"] = sleep
        with patch.dict(os.environ, self.environment, clear=True), patch.object(deploy_pages, "urlopen", opener):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                try:
                    deploy_pages.deploy(**kwargs)
                except BaseException as error:
                    self.log.write_text(stderr.getvalue())
                    return error, stderr.getvalue()
        self.fail("deployment unexpectedly succeeded")

    def test_success_polls_pending_then_succeeds_and_writes_url_after_success(self) -> None:
        opener = OpenSequence(
            [
                response(200, {"value": "oidc-jwt-secret"}),
                response(200, {"id": "deployment-1", "page_url": "storage.telecrypt.io"}),
                response(200, {"status": "in_progress"}),
                response(200, {"status": "succeed"}),
            ]
        )
        now = [0.0]
        stderr = self.run_deploy(
            opener,
            clock=lambda: now[0],
            sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
        )
        self.assertIn('Pages deployment status response (200):', stderr)
        self.assertEqual(self.output.read_text(), "page_url=storage.telecrypt.io\n")
        self.assertEqual(len(opener.requests), 4)
        create = opener.requests[1]
        self.assertEqual(
            create.full_url,
            "https://api.github.com/repos/TeleCrypt-io/storage.telecrypt.io/pages/deployments",
        )
        self.assertEqual(create.get_header("Authorization"), "Bearer gh-secret-token")
        self.assertEqual(create.get_header("X-github-api-version"), deploy_pages.API_VERSION)
        self.assertEqual(
            json.loads(create.data),
            {
                "artifact_id": 123,
                "environment": "github-pages",
                "pages_build_version": "a" * 40,
                "oidc_token": "oidc-jwt-secret",
            },
        )

    def test_terminal_error_preserves_complete_response_without_cancelling(self) -> None:
        body = b'{"status":"deployment_failed","error":{"message":"all details"}}'
        opener = OpenSequence(
            [
                response(200, {"value": "oidc-jwt"}),
                response(200, {"id": "deployment-1", "page_url": "storage.telecrypt.io"}),
                Response(200, body),
            ]
        )
        with self.assertRaises(deploy_pages.PagesFailure) as caught:
            self.run_deploy(opener, clock=lambda: 0.0, sleep=lambda _seconds: None)
        self.assertIn(body.decode(), str(caught.exception))
        self.assertEqual(len(opener.requests), 3)

    def test_invalid_json_preserves_the_complete_body(self) -> None:
        body = b'{"incomplete": true, "tail": "preserved"'
        opener = OpenSequence([response(200, {"value": "oidc-jwt"}), Response(200, body)])
        caught, _stderr = self.run_deploy_error(opener)
        self.assertIn("invalid JSON", str(caught))
        self.assertIn(body.decode(), str(caught))

    def test_partial_response_read_is_retained_and_response_is_closed(self) -> None:
        body = b'{"partial":true'
        partial = PartialResponse(200, body)
        opener = OpenSequence([partial])
        caught, stderr = self.run_deploy_error(opener)
        self.assertIn(body.decode(), str(caught))
        self.assertIn(body.decode(), stderr)
        self.assertTrue(partial.closed)

    def test_response_close_failure_keeps_complete_body(self) -> None:
        body = b'{"detail":"complete"}'
        opener = OpenSequence([CloseFailureResponse(200, body)])
        caught, stderr = self.run_deploy_error(opener)
        self.assertIn("response close failed", str(caught))
        self.assertIn(body.decode(), str(caught))
        self.assertIn(body.decode(), stderr)

    def test_sigterm_during_response_read_is_preserved_and_cancelled(self) -> None:
        pending = SignalResponse(200, b'{"status":"in_progress"}')
        opener = OpenSequence(
            [
                response(200, {"value": "oidc-jwt"}),
                response(200, {"id": "deployment-1", "page_url": "storage.telecrypt.io"}),
                pending,
                Response(204, b""),
            ]
        )
        with self.assertRaises(deploy_pages.CancellationRequested):
            self.run_deploy(opener, clock=lambda: 0.0, sleep=lambda _seconds: None)
        self.assertTrue(pending.closed)
        self.assertEqual(len(opener.requests), 4)

    def test_http_error_response_is_closed(self) -> None:
        error = TrackingHTTPError(b'{"message":"denied"}')
        opener = OpenSequence([error])
        caught, _stderr = self.run_deploy_error(opener)
        self.assertIsInstance(caught, deploy_pages.PagesFailure)
        self.assertTrue(error.closed)

    def test_timeout_cancels_once_and_preserves_last_status_response(self) -> None:
        status_body = b'{"status":"in_progress","detail":"last response"}'
        opener = OpenSequence(
            [
                response(200, {"value": "oidc-jwt"}),
                response(200, {"id": "deployment-1", "page_url": "storage.telecrypt.io"}),
                Response(200, status_body),
                Response(204, b""),
            ]
        )
        now = [0.0]
        with self.assertRaises(deploy_pages.DeploymentTimeout) as caught:
            self.run_deploy(
                opener,
                clock=lambda: now[0],
                sleep=lambda _seconds: now.__setitem__(0, 600.0),
            )
        self.assertIn(status_body.decode(), str(caught.exception))
        self.assertEqual(len(opener.requests), 4)
        self.assertTrue(opener.requests[-1].full_url.endswith("/pages/deployments/deployment-1/cancel"))

    def test_sigterm_cancels_active_deployment_once(self) -> None:
        opener = OpenSequence(
            [
                response(200, {"value": "oidc-jwt"}),
                response(200, {"id": "deployment-1", "page_url": "storage.telecrypt.io"}),
                response(200, {"status": "in_progress"}),
                Response(204, b""),
            ]
        )

        def interrupt(_seconds: float) -> None:
            os.kill(os.getpid(), signal.SIGTERM)

        with self.assertRaises(deploy_pages.CancellationRequested):
            self.run_deploy(opener, clock=lambda: 0.0, sleep=interrupt)
        self.assertEqual(len(opener.requests), 4)
        self.assertTrue(opener.requests[-1].full_url.endswith("/pages/deployments/deployment-1/cancel"))

    def test_cancellation_failure_keeps_original_and_cancellation_responses(self) -> None:
        cancel_body = b'{"message":"cancel failed","request_id":"retain-me"}'
        opener = OpenSequence(
            [
                response(200, {"value": "oidc-jwt"}),
                response(200, {"id": "deployment-1", "page_url": "storage.telecrypt.io"}),
                response(200, {"status": "in_progress"}),
                http_error(403, cancel_body),
            ]
        )
        now = [0.0]
        with self.assertRaises(deploy_pages.PagesFailure) as caught:
            self.run_deploy(
                opener,
                clock=lambda: now[0],
                sleep=lambda _seconds: now.__setitem__(0, 600.0),
            )
        message = str(caught.exception)
        self.assertIn("deployment failure:", message)
        self.assertIn("cancellation failure:", message)
        self.assertIn('{"status":"in_progress"}', message)
        self.assertIn(cancel_body.decode(), message)
        self.assertEqual(len(opener.requests), 4)

    def test_secrets_are_redacted_and_large_responses_are_not_capped(self) -> None:
        marker = "response-tail-" + ("x" * 200_000)
        body = json.dumps({"status": "deployment_failed", "detail": marker, "token": "oidc-jwt"}).encode()
        opener = OpenSequence(
            [
                Response(200, b'{"value":"oidc-jwt"}'),
                Response(200, b'{"id":"deployment-1","page_url":"storage.telecrypt.io","token":"oidc-jwt"}'),
                Response(200, body),
            ]
        )
        caught, stderr = self.run_deploy_error(
            opener,
            clock=lambda: 0.0,
            sleep=lambda _seconds: None,
        )
        self.assertIsInstance(caught, deploy_pages.PagesFailure)
        self.assertNotIn("gh-secret-token", stderr)
        self.assertNotIn("oidc-request-secret", stderr)
        self.assertNotIn("oidc-jwt", stderr)
        self.assertIn(marker, stderr)

    def test_malformed_oidc_response_redacts_returned_token_before_logging(self) -> None:
        body = b'{"value":"oidc-jwt-malformed"'
        opener = OpenSequence([Response(200, body)])
        caught, stderr = self.run_deploy_error(opener)
        self.assertIn("invalid JSON", str(caught))
        self.assertNotIn("oidc-jwt-malformed", stderr)

    def test_oidc_error_response_redacts_returned_token_before_logging(self) -> None:
        body = b'{"value":"oidc-jwt-error","message":"denied"}'
        opener = OpenSequence([http_error(500, body)])
        caught, stderr = self.run_deploy_error(opener)
        self.assertIsInstance(caught, deploy_pages.PagesFailure)
        self.assertNotIn("oidc-jwt-error", stderr)

    def test_redirect_handler_rejects_redirects(self) -> None:
        request = deploy_pages.Request("https://api.github.com/test", headers={"Authorization": "Bearer secret"})
        handler = deploy_pages.RejectRedirectHandler()
        self.assertIsNone(handler.redirect_request(request, None, 302, "Found", {}, "https://other.example"))

    def test_missing_output_path_is_explicit(self) -> None:
        opener = OpenSequence([])
        environment = {key: value for key, value in self.environment.items() if key != "GITHUB_OUTPUT"}
        with patch.dict(os.environ, environment, clear=True), patch.object(deploy_pages, "urlopen", opener):
            with self.assertRaises(deploy_pages.PagesFailure) as caught:
                deploy_pages.deploy(clock=lambda: 0.0, sleep=lambda _seconds: None)
        self.assertIn("GITHUB_OUTPUT is required", str(caught.exception))
        self.assertEqual(opener.requests, [])


if __name__ == "__main__":
    unittest.main()
