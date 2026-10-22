"""Download a repository as an archive over HTTPS (no `git` binary needed, works on Vercel).

Supports GitHub, GitLab, Bitbucket, Codeberg and Azure DevOps, public or private (access token).
The token is used for this one download only: never stored, never logged.
"""
from __future__ import annotations

import base64
import json
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from ..config import settings
from .files import IngestError, collapse_single_root, git_clone, safe_extract_zip, validate_git_url

UA = "NexMind/1.1 (+https://github.com/LoganthP/NexMind)"
NOT_FOUND = "Repository or branch not found, or it is private. For a private repository, paste an access token with read access."


def _parts(url: str) -> tuple[str, list[str]]:
    u = urllib.parse.urlparse(url)
    segs = [s for s in u.path.split("/") if s]
    if segs and segs[-1].endswith(".git"):
        segs[-1] = segs[-1][:-4]
    return (u.hostname or "").lower(), segs


def archive_request(url: str, branch: str | None, token: str | None) -> urllib.request.Request:
    host, segs = _parts(url)
    headers = {"User-Agent": UA}
    if host == "github.com":
        if len(segs) < 2:
            raise IngestError("Use a GitHub URL like https://github.com/owner/repo")
        if token:  # private repos: authenticated API (5,000 requests/hour per token)
            ref = urllib.parse.quote(branch, safe="") if branch else ""
            target = f"https://api.github.com/repos/{segs[0]}/{segs[1]}/zipball/{ref}".rstrip("/")
            headers["Accept"] = "application/vnd.github+json"
            headers["Authorization"] = f"Bearer {token}"
        else:  # public repos: codeload has no API rate limit (important on shared serverless IPs)
            ref = urllib.parse.quote(branch, safe="/") if branch else "HEAD"
            target = f"https://codeload.github.com/{segs[0]}/{segs[1]}/zip/{ref}"
    elif host == "gitlab.com":
        path = "/".join(s for s in segs if s != "-")
        if "/tree/" in "/" + path + "/":
            path = path.split("/tree/")[0]
        target = f"https://gitlab.com/api/v4/projects/{urllib.parse.quote(path, safe='')}/repository/archive.zip"
        if branch:
            target += "?sha=" + urllib.parse.quote(branch, safe="")
        if token:
            headers["PRIVATE-TOKEN"] = token
    elif host == "bitbucket.org":
        if len(segs) < 2:
            raise IngestError("Use a Bitbucket URL like https://bitbucket.org/owner/repo")
        target = f"https://bitbucket.org/{segs[0]}/{segs[1]}/get/{urllib.parse.quote(branch or 'HEAD', safe='')}.zip"
        if token:
            headers["Authorization"] = "Basic " + base64.b64encode(f"x-token-auth:{token}".encode()).decode()
    elif host == "codeberg.org":
        if len(segs) < 2:
            raise IngestError("Use a Codeberg URL like https://codeberg.org/owner/repo")
        ref = branch or _codeberg_default(segs[0], segs[1], token)
        target = f"https://codeberg.org/api/v1/repos/{segs[0]}/{segs[1]}/archive/{urllib.parse.quote(ref, safe='')}.zip"
        if token:
            headers["Authorization"] = f"token {token}"
    elif host == "dev.azure.com":
        if "_git" not in segs or len(segs) < 4:
            raise IngestError("Use an Azure DevOps URL like https://dev.azure.com/org/project/_git/repo")
        i = segs.index("_git")
        org, project, repo = segs[0], "/".join(segs[1:i]), segs[i + 1]
        q = {"path": "/", "$format": "zip", "download": "true", "api-version": "7.1"}
        if branch:
            q.update({"versionDescriptor.version": branch, "versionDescriptor.versionType": "branch"})
        target = f"https://dev.azure.com/{org}/{urllib.parse.quote(project)}/_apis/git/repositories/{urllib.parse.quote(repo)}/items?" + urllib.parse.urlencode(q)
        if token:
            headers["Authorization"] = "Basic " + base64.b64encode(f":{token}".encode()).decode()
    else:
        raise IngestError(f"Downloading from {host} is not supported")
    return urllib.request.Request(target, headers=headers)


def _codeberg_default(owner: str, repo: str, token: str | None) -> str:
    req = urllib.request.Request(f"https://codeberg.org/api/v1/repos/{owner}/{repo}", headers={"User-Agent": UA, **({"Authorization": f"token {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r).get("default_branch") or "main"
    except Exception:
        return "main"


def _download(req: urllib.request.Request, dest: Path, token: str | None) -> None:
    limit = settings.max_upload_mb * 1024 * 1024
    try:
        with urllib.request.urlopen(req, timeout=settings.git_timeout_s) as r, open(dest, "wb") as out:
            total = 0
            while True:
                chunk = r.read(1024 * 256)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise IngestError(f"The repository archive is larger than {settings.max_upload_mb} MB")
                out.write(chunk)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404, 406):
            raise IngestError(NOT_FOUND) from None
        raise IngestError(f"Download failed (HTTP {e.code}) from {req.host}") from None
    except urllib.error.URLError as e:
        reason = str(e.reason)
        if token:
            reason = reason.replace(token, "***")
        raise IngestError(f"Could not reach {req.host}: {reason}") from None
    except TimeoutError:
        raise IngestError("Downloading the repository timed out") from None


def fetch_repository(url: str, dest: Path, branch: str | None = None, token: str | None = None) -> Path:
    """Download + extract a repository into dest. Returns the folder that holds the project files."""
    url = validate_git_url(url)
    token = (token or "").strip() or None
    if branch is not None:
        branch = branch.strip() or None
    dest.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="nexmind-dl-", dir=str(dest.parent)))
    archive = tmp / "repo.zip"
    try:
        try:
            _download(archive_request(url, branch, token), archive, token)
        except IngestError as e:
            # local installs with git can still clone hosts/edge cases the archive APIs reject
            if shutil.which("git") and not settings.hosted and str(e) != NOT_FOUND:
                git_clone(url, dest / "repo", branch, token)
                return dest / "repo"
            raise
        out = dest / "repo"
        safe_extract_zip(archive, out)
        return collapse_single_root(out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
