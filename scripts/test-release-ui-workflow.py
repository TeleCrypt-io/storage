#!/usr/bin/env python3
"""Exercise the actual release publisher shell step with an offline GitHub API."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parent.parent
TAG = "storage-web-v9.8.7"
VERSION = TAG.removeprefix("storage-web-v")
ARCHIVE_NAME = f"storage-web-{VERSION}.pages.zip"
REPOSITORY = "TeleCrypt-io/storage.telecrypt.io"
ARCHIVE_BYTES = b"validated-pages-archive"
ARCHIVE_DIGEST = "sha256:" + hashlib.sha256(ARCHIVE_BYTES).hexdigest()
COMMIT = ""


def workflow_publish_command() -> str:
    lines = (ROOT / ".github/workflows/release-ui.yml").read_text().splitlines()
    # This step ID is the existing output interface used by downstream jobs.
    start = lines.index("        id: publish")
    run = lines.index("        run: |", start) + 1
    command = []
    for line in lines[run:]:
        if line and len(line) - len(line.lstrip()) < 10:
            break
        command.append(line[10:] if line.startswith("          ") else line)
    return "\n".join(command) + "\n"


def run(*args: str, cwd: Path, env: dict[str, str] | None = None) -> str:
    fixture_env = os.environ.copy()
    fixture_env.update({"GIT_ALLOW_PROTOCOL": "file", "GIT_PROTOCOL_FROM_USER": "1"})
    if env is not None:
        fixture_env.update(env)
    return subprocess.run(
        args,
        cwd=cwd,
        env=fixture_env,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ).stdout.strip()


def release_record(
    *,
    release_id: int = 100,
    draft: bool = True,
    commit: str | None = None,
    digest: str = ARCHIVE_DIGEST,
    asset_id: int = 200,
    assets: list[dict] | None = None,
) -> dict:
    if assets is None:
        assets = [] if draft else [
            {
                "id": asset_id,
                "name": ARCHIVE_NAME,
                "state": "uploaded",
                "size": len(ARCHIVE_BYTES),
                "digest": digest,
            }
        ]
    return {
        "id": release_id,
        "tag_name": TAG,
        "name": TAG,
        "body": f"Release {TAG}",
        "target_commitish": COMMIT if commit is None else commit,
        "draft": draft,
        "prerelease": False,
        "immutable": False if draft else True,
        "created_at": "2026-09-12T10:00:00Z",
        "published_at": None if draft else "2026-09-12T10:00:01Z",
        "assets": assets,
        "upload_url": f"https://uploads.github.com/repos/{REPOSITORY}/releases/{release_id}/assets{{?name,label}}",
    }


def fake_gh() -> int:
    state_path = Path(os.environ["FAKE_GH_STATE"])
    state = json.loads(state_path.read_text())
    args = sys.argv[1:]
    method = "GET"
    fields: dict[str, str] = {}
    input_path = None
    route = None
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in {"--hostname", "--header"}:
            index += 2
        elif arg == "--method":
            method = args[index + 1]
            index += 2
        elif arg in {"--raw-field", "--field"}:
            name, value = args[index + 1].split("=", 1)
            fields[name] = value
            index += 2
        elif arg == "--input":
            input_path = args[index + 1]
            index += 2
        elif arg.startswith("-"):
            raise AssertionError(f"unexpected gh option: {arg}")
        else:
            route = arg
            index += 1
    if route is None:
        raise AssertionError("missing GitHub API route")

    parsed = urlsplit(route)
    path = parsed.path.lstrip("/")
    query = parse_qs(parsed.query)
    state["calls"].append({"method": method, "path": path, "query": query})
    release = state.get("release")

    def json_output(value: object) -> int:
        sys.stdout.write(json.dumps(value, separators=(",", ":")))
        state_path.write_text(json.dumps(state))
        return 0

    if state.get("transport_failure") and path.endswith("/releases") and query.get("page") == ["1"]:
        sys.stdout.write('{"response":')
        sys.stderr.write("simulated GitHub API transport failure\n")
        state_path.write_text(json.dumps(state))
        return 7
    if state.get("invalid_json") and path.endswith("/releases") and query.get("page") == ["1"]:
        sys.stdout.write("not a JSON response\n")
        state_path.write_text(json.dumps(state))
        return 0

    if path.endswith("/releases") and method == "GET":
        records = state.get("releases", [])
        page = int(query.get("page", ["1"])[0])
        offset = (page - 1) * 100
        return json_output(records[offset : offset + 100])

    if path.endswith("/releases") and method == "POST":
        record = release_record(draft=True, commit=fields["target_commitish"])
        record["tag_name"] = fields["tag_name"]
        record["name"] = fields["name"]
        record["body"] = fields["body"]
        record["draft"] = fields["draft"] == "true"
        record["prerelease"] = fields["prerelease"] == "true"
        state["release"] = record
        state["releases"] = [record]
        state["mutations"].append("create")
        return json_output(record)

    if "/releases/assets/" in path:
        asset_id = int(path.rsplit("/", 1)[1])
        if method == "DELETE":
            if release is not None:
                release["assets"] = [asset for asset in release["assets"] if asset["id"] != asset_id]
            state["asset_data"].pop(str(asset_id), None)
            state["mutations"].append("delete")
            state_path.write_text(json.dumps(state))
            return 0
        data = base64.b64decode(state["asset_data"][str(asset_id)])
        sys.stdout.buffer.write(data)
        return 0

    if "/releases/" in path and path.endswith("/assets") and method == "POST":
        if release is None or input_path is None:
            raise AssertionError("upload requires a release and archive input")
        data = Path(input_path).read_bytes()
        asset_id = 200 + len(state["mutations"])
        asset_name = query.get("name", [""])[0]
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        if state.get("wrong_upload_digest"):
            digest = "sha256:" + "0" * 64
        asset = {
            "id": asset_id,
            "name": asset_name,
            "state": "uploaded",
            "size": len(data),
            "digest": digest,
        }
        release["assets"].append(asset)
        state["asset_data"][str(asset_id)] = base64.b64encode(data).decode()
        state["mutations"].append("upload")
        return json_output(asset)

    if "/releases/" in path:
        if release is None:
            raise AssertionError(f"release {path} does not exist")
        if method == "PATCH":
            release["draft"] = fields["draft"] == "true"
            release["immutable"] = not release["draft"]
            release["published_at"] = "2026-09-12T10:00:01Z"
            state["mutations"].append("publish")
            return json_output(release)
        state["release_gets"] = state.get("release_gets", 0) + 1
        if state.get("mutate_release_get") == state["release_gets"] and release["assets"]:
            release["assets"][0]["digest"] = "sha256:" + "f" * 64
        return json_output(release)

    raise AssertionError(f"unhandled GitHub API request: {method} {route}")


class PublisherWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        global COMMIT
        cls.temporary_directory = tempfile.TemporaryDirectory(prefix="storage-web-release-workflow-test-")
        cls.addClassCleanup(cls.temporary_directory.cleanup)
        cls.root = Path(cls.temporary_directory.name)
        cls.remote = cls.root / "origin.git"
        cls.seed = cls.root / "seed"
        cls.work = cls.root / "work"
        cls.command = workflow_publish_command()
        cls.script = Path(__file__).resolve()
        cls.bare_git(cls.remote)
        cls.git(cls.seed, "init", "--initial-branch=main")
        cls.git(cls.seed, "config", "user.name", "Release workflow test")
        cls.git(cls.seed, "config", "user.email", "release-test@example.invalid")
        (cls.seed / "scripts").mkdir()
        shutil.copy(ROOT / "scripts/release-common.sh", cls.seed / "scripts/release-common.sh")
        (cls.seed / "source.txt").write_text("publisher test fixture\n")
        cls.git(cls.seed, "add", ".")
        cls.git(cls.seed, "commit", "-m", "publisher workflow fixture")
        cls.git(cls.seed, "tag", "-a", TAG, "-m", "publisher workflow fixture")
        COMMIT = cls.git(cls.seed, "rev-parse", "HEAD")
        cls.git(cls.seed, "remote", "add", "origin", str(cls.remote))
        cls.git(cls.seed, "push", "origin", "main", TAG)

    @staticmethod
    def bare_git(path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "--bare", str(path)], check=True, capture_output=True, text=True)

    @staticmethod
    def git(path: Path, *args: str) -> str:
        path.mkdir(parents=True, exist_ok=True)
        return run("git", *args, cwd=path)

    def fixture(self, case: str, *, existing: dict | None = None, **settings: object) -> tuple[Path, dict[str, str], Path]:
        directory = self.root / case
        checkout = directory / "checkout"
        directory.mkdir(parents=True, exist_ok=True)
        run("git", "clone", str(self.remote), str(checkout), cwd=directory)
        run("git", "checkout", "--detach", COMMIT, cwd=checkout)
        archive = checkout / "release-assets" / ARCHIVE_NAME
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(ARCHIVE_BYTES)
        runner_temp = directory / "runner-temp"
        runner_temp.mkdir()
        output = directory / "github-output"
        output.write_text("")
        asset_data = {}
        if existing is not None:
            for asset in existing["assets"]:
                asset_data[str(asset["id"])] = base64.b64encode(ARCHIVE_BYTES).decode()
        expected_digest = str(settings.pop("expected_digest", ARCHIVE_DIGEST))
        initial = {
            "release": existing,
            "releases": [] if existing is None else [dict(existing)],
            "mutations": [],
            "calls": [],
            "asset_data": asset_data,
            **settings,
        }
        state_path = directory / "gh-state.json"
        state_path.write_text(json.dumps(initial))
        fake_bin = directory / "bin"
        fake_bin.mkdir()
        fake_gh = fake_bin / "gh"
        fake_gh.write_text(f"#!/bin/sh\nFAKE_GH_MODE=1 exec {sys.executable} {self.script} \"$@\"\n")
        fake_gh.chmod(0o755)
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{fake_bin}:{env['PATH']}",
                "RUNNER_TEMP": str(runner_temp),
                "GITHUB_OUTPUT": str(output),
                "GITHUB_REPOSITORY": REPOSITORY,
                "GITHUB_SHA": COMMIT,
                "GITHUB_RUN_ID": "1",
                "GITHUB_RUN_ATTEMPT": "2" if existing and not existing["draft"] else "1",
                "GITHUB_EVENT_NAME": "push",
                "RELEASE_TAG": TAG,
                "RELEASE_SHA": COMMIT,
                "EXPECTED_DIGEST": expected_digest,
                "EXPECTED_SIZE": str(len(ARCHIVE_BYTES)),
                "GH_TOKEN": "offline-test-token",
                "FAKE_GH_STATE": str(state_path),
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
                # The publisher runs against this local bare fixture only.
                "GIT_ALLOW_PROTOCOL": "file",
                "GIT_PROTOCOL_FROM_USER": "1",
            }
        )
        return checkout, env, output

    def execute(self, case: str, **kwargs: object) -> tuple[subprocess.CompletedProcess, dict, str]:
        checkout, env, output = self.fixture(case, **kwargs)
        result = subprocess.run(
            ["bash", "-c", self.command],
            cwd=checkout,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        state = json.loads(Path(env["FAKE_GH_STATE"]).read_text())
        return result, state, output.read_text()

    def test_absent_release_is_created_uploaded_and_published(self) -> None:
        result, state, output = self.execute("absent")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release_id=100", output)
        self.assertEqual(state["mutations"], ["create", "upload", "publish"])
        self.assertFalse(state["release"]["draft"])
        self.assertEqual(state["release"]["assets"][0]["digest"], ARCHIVE_DIGEST)

    def test_existing_draft_is_resumed_and_old_assets_replaced(self) -> None:
        old_asset = {
            "id": 41,
            "name": "previous-archive.zip",
            "state": "uploaded",
            "size": 3,
            "digest": "sha256:" + "1" * 64,
        }
        result, state, output = self.execute("draft", existing=release_record(assets=[old_asset]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release_id=100", output)
        self.assertEqual(state["mutations"], ["delete", "upload", "publish"])
        self.assertEqual([asset["name"] for asset in state["release"]["assets"]], [ARCHIVE_NAME])

    def test_exact_immutable_release_rerun_reuses_without_mutation(self) -> None:
        published = release_record(draft=False)
        result, state, output = self.execute("published", existing=published)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release_id=100", output)
        self.assertEqual(state["mutations"], [])

    def test_release_identity_conflict_stops_before_asset_mutations(self) -> None:
        conflicting = release_record(assets=[])
        conflicting["body"] = "different release"
        result, state, _ = self.execute("conflict", existing=conflicting)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["mutations"], [])

    def test_changed_draft_metadata_stops_before_publish(self) -> None:
        result, state, _ = self.execute(
            "draft-changes",
            mutate_release_get=3,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("publish", state["mutations"])

    def test_uploaded_asset_with_wrong_digest_stops_before_publish(self) -> None:
        result, state, _ = self.execute("wrong-upload-digest", wrong_upload_digest=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["mutations"], ["create", "upload"])

    def test_bad_build_digest_stops_before_release_api_mutation(self) -> None:
        result, state, _ = self.execute("bad-build-digest", expected_digest="sha256:" + "0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["calls"], [])
        self.assertEqual(state["mutations"], [])

    def test_api_failure_replays_response_and_error_diagnostics(self) -> None:
        result, state, _ = self.execute("api-failure", transport_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('{"response":', result.stderr)
        self.assertIn("simulated GitHub API transport failure", result.stderr)
        self.assertEqual(state["mutations"], [])

    def test_invalid_api_json_is_reported_with_original_response(self) -> None:
        result, state, _ = self.execute("invalid-json", invalid_json=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a JSON response", result.stderr)
        self.assertIn("parse error", result.stderr)
        self.assertEqual(state["mutations"], [])

    def test_release_discovery_reaches_later_page(self) -> None:
        old_releases = [
            {"id": index + 1000, "tag_name": f"storage-web-v0.{index}.0", "draft": False}
            for index in range(100)
        ]
        draft = release_record(assets=[])
        records = old_releases + [draft]
        # Add older releases to the first full page and find the draft on page 2.
        checkout, env, output_path = self.fixture("pagination-retry", existing=draft)
        state_path = Path(env["FAKE_GH_STATE"])
        current = json.loads(state_path.read_text())
        current["releases"] = records
        state_path.write_text(json.dumps(current))
        env["FAKE_GH_MODE"] = "1"
        result = subprocess.run(["bash", "-c", self.command], cwd=checkout, env=env, capture_output=True, text=True)
        state = json.loads(state_path.read_text())
        self.assertEqual(result.returncode, 0, result.stderr)
        pages = [call["query"].get("page", ["1"])[0] for call in state["calls"] if "page" in call["query"]]
        self.assertEqual(pages, ["1", "2"])
        self.assertIn("release_id=100", output_path.read_text())


if __name__ == "__main__":
    if os.environ.get("FAKE_GH_MODE") == "1":
        raise SystemExit(fake_gh())
    unittest.main(verbosity=2)
