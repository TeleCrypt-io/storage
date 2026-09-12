#!/usr/bin/env python3
"""Deploy one already-uploaded Pages artifact through the GitHub REST API."""

from __future__ import annotations

import json
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


API_BASE = "https://api.github.com"
API_VERSION = "2026-03-10"
API_TIMEOUT_SECONDS = 60
DEPLOYMENT_WAIT_SECONDS = 600
POLL_SECONDS = 5
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")

TERMINAL_FAILURES = frozenset(
    {
        "deployment_failed",
        "deployment_content_failed",
        "deployment_cancelled",
        "deployment_lost",
    }
)


class PagesFailure(Exception):
    """A failure that should be reported with the complete API response."""

    def __init__(self, message: str, response: str = "") -> None:
        super().__init__(message)
        self.response = response

    def __str__(self) -> str:
        if not self.response:
            return super().__str__()
        return f"{super().__str__()}\n{self.response}"


class JsonResponse(dict[str, Any]):
    """A decoded response with its complete redacted wire representation."""

    def __init__(self, value: dict[str, Any], response: str) -> None:
        super().__init__(value)
        self.response = response


class CancellationRequested(BaseException):
    """Raised by the signal handler so the active deployment can be cancelled."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"received signal {signum}")
        self.signum = signum


class DeploymentTimeout(PagesFailure):
    """The Pages deployment did not complete within the ten-minute wait."""


class RejectRedirectHandler(HTTPRedirectHandler):
    """Do not forward bearer credentials to a redirected host."""

    def redirect_request(
        self,
        request: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        new_url: str,
    ) -> None:
        return None


urlopen = build_opener(RejectRedirectHandler()).open


def redact(value: str, secrets: list[str]) -> str:
    """Mask known credentials while preserving every other response byte."""

    redacted = value
    for secret in sorted({item for item in secrets if item}, key=len, reverse=True):
        redacted = redacted.replace(secret, "***")
    return redacted


def remember_oidc_value(operation: str, body: bytes | str, secrets: list[str]) -> None:
    if operation != "OIDC token request":
        return
    text = body.decode("utf-8", errors="backslashreplace") if isinstance(body, bytes) else body
    match = re.search(r'"value"\s*:\s*"((?:\\.|[^"\\])*)', text)
    if match:
        raw_value = match.group(1)
        if raw_value:
            secrets.append(raw_value)
        try:
            value = json.loads(f'"{raw_value}"')
        except json.JSONDecodeError:
            value = raw_value
        if isinstance(value, str) and value:
            secrets.append(value)


def report_response(operation: str, status: int | str, body: bytes | str, secrets: list[str]) -> str:
    text = body.decode("utf-8", errors="backslashreplace") if isinstance(body, bytes) else body
    safe = redact(text, secrets)
    print(f"{operation} response ({status}):", file=sys.stderr)
    print(safe, file=sys.stderr, end="" if safe.endswith("\n") else "\n")
    return safe


def read_body(response: Any, operation: str, status: int | str, secrets: list[str]) -> bytes:
    body: bytes = b""
    read_error: Exception | None = None
    try:
        body = response.read()
    except Exception as error:
        partial = getattr(error, "partial", b"")
        body = partial if isinstance(partial, bytes) else b""
        read_error = error
    except BaseException as error:
        partial = getattr(error, "partial", b"")
        body = partial if isinstance(partial, bytes) else b""
        remember_oidc_value(operation, body, secrets)
        report_response(operation, status, body, secrets)
        try:
            response.close()
        except Exception:
            pass
        raise
    remember_oidc_value(operation, body, secrets)
    safe = report_response(operation, status, body, secrets)
    try:
        response.close()
    except Exception:
        pass
    if read_error is not None:
        detail = redact(str(read_error), secrets)
        message = f"{operation} response read failed: {detail}"
        raise PagesFailure(message, safe) from read_error
    return body


def request_json(
    operation: str,
    method: str,
    url: str,
    token: str,
    secrets: list[str],
    payload: dict[str, Any] | None = None,
    expected_status: int = 200,
) -> JsonResponse:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": API_VERSION,
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=data, headers=headers, method=method)

    try:
        response = urlopen(request, timeout=API_TIMEOUT_SECONDS)
        status = int(response.getcode())
        body = read_body(response, operation, status, secrets)
    except HTTPError as error:
        try:
            body = read_body(error, operation, error.code, secrets)
        except PagesFailure as read_failure:
            raise PagesFailure(
                f"{operation} returned HTTP {error.code}; {read_failure.args[0]}", read_failure.response
            ) from error
        safe = redact(
            body.decode("utf-8", errors="backslashreplace") if isinstance(body, bytes) else body,
            secrets,
        )
        raise PagesFailure(f"{operation} returned unexpected HTTP status {error.code}", safe) from error
    except (OSError, URLError, TimeoutError) as error:
        detail = redact(str(error), secrets)
        print(f"{operation} transport failure: {detail}", file=sys.stderr)
        raise PagesFailure(f"{operation} transport failure: {detail}") from error

    safe = redact(body.decode("utf-8", errors="backslashreplace"), secrets)
    try:
        parsed = json.loads(body.decode("utf-8")) if body else None
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PagesFailure(f"{operation} returned invalid JSON", safe) from error
    if status != expected_status:
        raise PagesFailure(f"{operation} returned unexpected HTTP status {status}", safe)
    if expected_status == 204 and not body:
        return JsonResponse({}, safe)
    if not isinstance(parsed, dict):
        raise PagesFailure(f"{operation} returned a JSON value that is not an object", safe)
    return JsonResponse(parsed, safe)


def oidc_token(secrets: list[str]) -> str:
    request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
    if not request_url or not request_token:
        raise PagesFailure("GitHub Actions OIDC request environment is incomplete")
    response = request_json(
        "OIDC token request",
        "GET",
        request_url,
        request_token,
        secrets + [request_token],
    )
    value = response.get("value")
    if not isinstance(value, str) or not value:
        raise PagesFailure("OIDC token response does not contain a token", response.response)
    secrets.append(value)
    return value


def required_environment() -> tuple[str, str, str, str]:
    artifact_id = os.environ.get("PAGES_ARTIFACT_ID", "")
    build_version = os.environ.get("PAGES_BUILD_VERSION", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    github_token = os.environ.get("GH_TOKEN", "")
    if not re.fullmatch(r"[1-9][0-9]*", artifact_id):
        raise PagesFailure("PAGES_ARTIFACT_ID must be a positive decimal integer")
    if not SHA_PATTERN.fullmatch(build_version):
        raise PagesFailure("PAGES_BUILD_VERSION must be a 40-character lowercase commit SHA")
    if repository.count("/") != 1 or any(not part for part in repository.split("/")):
        raise PagesFailure("GITHUB_REPOSITORY must be OWNER/REPOSITORY")
    if not github_token:
        raise PagesFailure("GH_TOKEN is required")
    if not os.environ.get("GITHUB_OUTPUT"):
        raise PagesFailure("GITHUB_OUTPUT is required for Pages deployment outputs")
    return artifact_id, build_version, repository, github_token


def github_url(repository: str, suffix: str) -> str:
    owner, repo = repository.split("/", 1)
    return f"{API_BASE}/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/{suffix}"


def write_output(name: str, value: str) -> None:
    output_path = os.environ["GITHUB_OUTPUT"]
    with Path(output_path).open("a", encoding="utf-8") as output:
        output.write(f"{name}={value}\n")


def cancel_deployment(repository: str, deployment_id: str, token: str, secrets: list[str]) -> None:
    request_json(
        "Pages deployment cancellation",
        "POST",
        github_url(repository, f"pages/deployments/{quote(deployment_id, safe='')}/cancel"),
        token,
        secrets,
        expected_status=204,
    )


def combine_failures(original: BaseException, cancellation: BaseException) -> PagesFailure:
    original_text = str(original)
    cancellation_text = str(cancellation)
    detail = f"deployment failure: {original_text}"
    detail += f"\ncancellation failure: {cancellation_text}"
    return PagesFailure(detail)


def deploy(
    *,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    artifact_id, build_version, repository, github_token = required_environment()
    secrets = [github_token, os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")]
    deployment_id: str | None = None
    deployment_pending = False
    def handle_signal(signum: int, _frame: Any) -> None:
        raise CancellationRequested(signum)

    old_int = signal.signal(signal.SIGINT, handle_signal)
    old_term = signal.signal(signal.SIGTERM, handle_signal)
    try:
        token = oidc_token(secrets)
        deployment = request_json(
            "Pages deployment creation",
            "POST",
            github_url(repository, "pages/deployments"),
            github_token,
            secrets + [token],
            {
                "artifact_id": int(artifact_id),
                "environment": "github-pages",
                "pages_build_version": build_version,
                "oidc_token": token,
            },
            expected_status=200,
        )
        deployment_id_value = deployment.get("id")
        if not isinstance(deployment_id_value, (str, int)) or not str(deployment_id_value):
            raise PagesFailure("Pages deployment response does not contain an id", deployment.response)
        deployment_id = str(deployment_id_value)
        deployment_pending = True
        page_url = deployment.get("page_url")
        if not isinstance(page_url, str) or not page_url:
            raise PagesFailure("Pages deployment response does not contain page_url", deployment.response)

        deadline = clock() + DEPLOYMENT_WAIT_SECONDS
        last_response = deployment.response
        while True:
            if clock() >= deadline:
                raise DeploymentTimeout("Pages deployment timed out after 600 seconds", last_response)
            status_response = request_json(
                "Pages deployment status",
                "GET",
                github_url(repository, f"pages/deployments/{quote(deployment_id, safe='')}"),
                github_token,
                secrets,
                expected_status=200,
            )
            last_response = status_response.response
            status = status_response.get("status")
            if not isinstance(status, str) or not status:
                raise PagesFailure("Pages deployment status response has no status", last_response)
            if status == "succeed":
                deployment_pending = False
                write_output("page_url", page_url)
                return
            if status in TERMINAL_FAILURES:
                deployment_pending = False
                raise PagesFailure(f"Pages deployment reached terminal status {status}", last_response)
            sleep(min(POLL_SECONDS, max(0, deadline - clock())))
    except BaseException as error:
        if deployment_pending and deployment_id is not None:
            try:
                # An active deployment gets one cancellation attempt for the original failure.
                previous_int = signal.signal(signal.SIGINT, signal.SIG_IGN)
                previous_term = signal.signal(signal.SIGTERM, signal.SIG_IGN)
                try:
                    cancel_deployment(repository, deployment_id, github_token, secrets)
                finally:
                    signal.signal(signal.SIGINT, previous_int)
                    signal.signal(signal.SIGTERM, previous_term)
                deployment_pending = False
            except BaseException as cancellation_error:
                raise combine_failures(error, cancellation_error) from cancellation_error
        raise
    finally:
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)


def main() -> int:
    try:
        deploy()
    except BaseException as error:
        secrets = [os.environ.get("GH_TOKEN", ""), os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")]
        print(f"Pages deployment failed: {redact(str(error), secrets)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
