"""NexMind connect: link the folder you are in (for example the project open in VS Code) to NexMind.

Standard library only and ASCII only, so the server can hand it out as a single file:
    Windows PowerShell:  irm "https://YOUR-SITE/connect.py?k=KEY" | python - .
    macOS / Linux:       curl -fsS "https://YOUR-SITE/connect.py?k=KEY" | python3 - .
Works with a NexMind server on this computer (folder indexed in place) and with the hosted app
(the folder is zipped, uploaded and re-uploaded whenever files change).
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

DEFAULT_SERVER = "http://127.0.0.1:8000"
DEFAULT_KEY = ""
IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "env", "dist", "build", ".idea",
    ".vscode", ".next", ".nuxt", "target", "vendor", ".gradle", ".tox", ".mypy_cache", ".pytest_cache",
    "coverage", ".cache", "bower_components", "site-packages", ".dart_tool", "Pods", "__MACOSX", ".turbo",
}
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".mp4", ".mov", ".mp3", ".wav", ".zip", ".gz",
    ".tgz", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin", ".pyc", ".class", ".jar", ".woff", ".woff2",
    ".ttf", ".otf", ".psd", ".sqlite", ".db", ".lock", ".min.js", ".map",
}
MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 100 * 1024 * 1024


def say(msg=""):
    try:
        if isinstance(msg, str):
            msg = msg.encode("ascii", "replace").decode("ascii")
        print(msg, flush=True)
    except Exception:
        pass


class Fail(Exception):
    def __init__(self, msg, code=1):
        Exception.__init__(self, msg)
        self.code = code


class Client(object):
    def __init__(self, server, key):
        self.server = server.rstrip("/")
        self.key = key

    def _req(self, method, path, body=None, raw=None, ctype=None, timeout=60):
        headers = {"User-Agent": "nexmind-connect/1.1"}
        if self.key:
            headers["X-NexMind-Key"] = self.key
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif raw is not None:
            data = raw
            headers["Content-Type"] = ctype or "application/octet-stream"
        req = urllib.request.Request(self.server + path, data=data, method=method, headers=headers)
        return urllib.request.urlopen(req, timeout=timeout)

    def call(self, method, path, body=None, raw=None, timeout=60):
        try:
            with self._req(method, path, body, raw, timeout=timeout) as r:
                text = r.read().decode("utf-8") or "null"
                return json.loads(text)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read().decode("utf-8")).get("detail", "")
            except Exception:
                pass
            if not isinstance(detail, str):
                detail = ""
            if e.code in (404, 405, 422) and not detail:
                raise Fail("Your NexMind backend is out of date. Update and restart it.")
            if e.code == 403:
                raise Fail(detail or "The server refused access to this folder.")
            raise Fail(detail or ("Server error %d" % e.code))
        except urllib.error.URLError:
            raise Fail("Cannot reach NexMind at %s.\nIf you run NexMind on this computer, start it first:  python -m nexmind serve" % self.server)


def is_loopback(url):
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1")


def folder_signature(root):
    count, newest, total = 0, 0.0, 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".")]
        for fn in filenames:
            try:
                st = os.stat(os.path.join(dirpath, fn))
            except OSError:
                continue
            count += 1
            total += st.st_size
            newest = max(newest, st.st_mtime)
    return (count, round(newest, 3), total)


def make_zip(root):
    buf = io.BytesIO()
    total = 0
    files = 0
    top = os.path.basename(os.path.abspath(root)) or "project"
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and not d.startswith("."))
            for fn in sorted(filenames):
                low = fn.lower()
                if any(low.endswith(ext) for ext in BINARY_EXT) or fn.startswith("."):
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    continue
                if size == 0 or size > MAX_FILE:
                    continue
                total += size
                if total > MAX_TOTAL:
                    raise Fail("This folder has more than 100 MB of source files. Connect a smaller folder (for example src).", 2)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                z.write(full, top + "/" + rel)
                files += 1
    if files == 0:
        raise Fail("No source files found in this folder.", 2)
    return buf.getvalue(), files


def file_sha1(path):
    import hashlib
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def scan_source_files(root):
    result = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            low = fn.lower()
            if any(low.endswith(ext) for ext in BINARY_EXT) or fn.startswith("."):
                continue
            full = os.path.join(dirpath, fn)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if size == 0 or size > MAX_FILE:
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            result[rel] = full
    return result


def make_delta_zip(root, paths_to_include):
    buf = io.BytesIO()
    top = os.path.basename(os.path.abspath(root)) or "project"
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in sorted(paths_to_include):
            full = os.path.join(root, rel.replace("/", os.sep))
            z.write(full, top + "/" + rel)
    return buf.getvalue()


def sync_hosted(client, root, name, watch):
    files_map = scan_source_files(root)
    manifest_res = {}
    try:
        manifest_res = client.call("POST", "/api/sources/manifest", {"path_hint": root})
    except Exception:
        pass

    server_files = manifest_res.get("files") if isinstance(manifest_res, dict) else {}
    if not server_files or not manifest_res.get("source_id"):
        data, n = make_zip(root)
        say("  Uploading %d files (%.1f MB)..." % (n, len(data) / 1048576.0))
        uid = upload(client, os.path.basename(root) + ".zip", data)
        return client.call("POST", "/api/connect/upload", {"upload_id": uid, "path_hint": root, "name": name, "watch": watch}, timeout=300)

    changed_or_new = []
    for rel, full in files_map.items():
        h = file_sha1(full)
        if server_files.get(rel) != h:
            changed_or_new.append(rel)
    deleted = [p for p in server_files.keys() if p not in files_map]

    if not changed_or_new and not deleted:
        return client.call("POST", "/api/connect/delta", {"path_hint": root, "upload_id": None, "deleted": [], "name": name, "watch": watch}, timeout=300)

    uid = None
    if changed_or_new:
        data = make_delta_zip(root, changed_or_new)
        say("  Uploading %d changed file%s (%.1f MB)..." % (len(changed_or_new), "" if len(changed_or_new) == 1 else "s", len(data) / 1048576.0))
        uid = upload(client, os.path.basename(root) + ".zip", data)

    return client.call("POST", "/api/connect/delta", {"path_hint": root, "upload_id": uid, "deleted": deleted, "name": name, "watch": watch}, timeout=300)


def upload(client, name, data):
    init = client.call("POST", "/api/uploads", {"name": name, "size": len(data)})
    size = int(init["chunk_size"])
    for i in range(int(init["chunks"])):
        client.call("PUT", "/api/uploads/%s/chunks/%d" % (init["upload_id"], i), raw=data[i * size:(i + 1) * size], timeout=120)
    return init["upload_id"]


def run_job(client, job_id):
    """Build the graph now (hosted servers build inside this request) and print progress."""
    last = ""
    try:
        with client._req("POST", "/api/jobs/%s/run" % job_id, body={}, timeout=330) as r:
            for line in r:
                line = line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") == "progress":
                    msg = "  %3d%%  %s" % (int(ev.get("percent", 0)), ev.get("message", ""))
                    if msg != last:
                        say(msg)
                        last = msg
                elif ev.get("type") == "job_failed":
                    raise Fail("Building the graph failed: %s" % ev.get("error", "unknown error"))
                elif ev.get("type") == "job_done":
                    s = ev.get("stats") or {}
                    say("  Graph ready: %s nodes, %s links" % (s.get("nodes", "?"), s.get("edges", "?")))
                    return
    except urllib.error.HTTPError as e:
        if e.code != 409:
            raise Fail("Could not start the build (HTTP %d)" % e.code)
    except urllib.error.URLError:
        pass
    # someone else is building it (or the stream was cut): wait for the result
    for _ in range(400):
        j = client.call("GET", "/api/jobs/%s" % job_id)
        if j.get("status") == "done":
            say("  Graph ready.")
            return
        if j.get("status") == "failed":
            raise Fail("Building the graph failed: %s" % (j.get("error") or "unknown error"))
        time.sleep(1.5)


def parse(argv):
    path, name, watch, server, key = ".", None, True, None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--name" and i + 1 < len(argv):
            name = argv[i + 1]
            i += 1
        elif a == "--no-watch":
            watch = False
        elif a == "--server" and i + 1 < len(argv):
            server = argv[i + 1]
            i += 1
        elif a == "--key" and i + 1 < len(argv):
            key = argv[i + 1]
            i += 1
        elif a in ("-h", "--help"):
            say(__doc__)
            raise SystemExit(0)
        elif not a.startswith("-"):
            path = a
        i += 1
    return path, name, watch, server or os.environ.get("NEXMIND_SERVER") or DEFAULT_SERVER, key or os.environ.get("NEXMIND_KEY") or DEFAULT_KEY


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    path, name, watch, server, key = parse(argv)
    root = os.path.abspath(os.path.expanduser(path.strip().strip('"')))
    if not os.path.isdir(root):
        say("Folder not found: %s" % root)
        return 2
    if os.path.dirname(root) == root:
        say("Choose a project folder, not a drive root.")
        return 2
    client = Client(server, key)
    try:
        health = client.call("GET", "/api/health", timeout=15)
        if not isinstance(health, dict) or health.get("app") != "nexmind":
            raise Fail("Something else is running at %s, not NexMind." % server)
        local = is_loopback(server) and bool((health.get("capabilities") or {}).get("local_paths"))
        if local:
            res = client.call("POST", "/api/connect", {"path": root, "name": name, "watch": watch})
        else:
            res = sync_hosted(client, root, name, watch)
        say("")
        say("Connected %s to NexMind%s" % (res.get("name", os.path.basename(root)), " (re-indexing)" if res.get("reused") else ""))
        site = health.get("web_url") if local else server
        say("Open:  %s%s" % ((site or server).rstrip("/"), res.get("url", "")))
        run_job(client, res["job_id"])
        if not watch:
            say("Indexed once (--no-watch).")
            return 0
        if local:
            say("Live sync is ON: the NexMind server watches this folder. You can close this terminal.")
            return 0
        say("Live sync is ON: edits in this folder update the graph. Keep this terminal open (Ctrl+C to stop).")
        sig = folder_signature(root)
        pending = None
        while True:
            time.sleep(2)
            now_sig = folder_signature(root)
            if now_sig == sig:
                pending = None
                continue
            if pending != now_sig:
                pending = now_sig
                time.sleep(1.5)
                continue
            sig = now_sig
            pending = None
            say("")
            say("  Files changed, updating the graph...")
            res = sync_hosted(client, root, name, True)
            run_job(client, res["job_id"])
    except Fail as e:
        say(str(e))
        return e.code
    except KeyboardInterrupt:
        say("")
        say("Stopped. Your workspace stays in NexMind; run the command again to re-sync.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
