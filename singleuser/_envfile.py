"""Tiny, dependency-free reader/writer for the single-user config file
(singleuser/.env). Kept separate from the app so run.py can use it BEFORE importing
the app package. NEVER touches server/.env — the multi-user app is unaffected.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def env_path():
    """Absolute path of the single-user config file.

    Defaults to singleuser/.env, but honors AIMS_ENV_FILE — the frozen (.exe)
    launcher points this at a writable per-user folder (e.g. %LOCALAPPDATA%),
    since the PyInstaller bundle itself is read-only/temporary.
    """
    return os.environ.get("AIMS_ENV_FILE") or os.path.join(HERE, ".env")


# Back-compat: some callers reference the module-level path.
ENV_PATH = env_path()


def read_env_file():
    """Return {KEY: value} from the config file ({} if absent)."""
    out = {}
    try:
        with open(env_path(), "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                key, val = line.split("=", 1)
                out[key.strip()] = val.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    except Exception:  # noqa: BLE001 - a bad file must never block startup
        pass
    return out


def upsert(updates):
    """Merge {KEY: value} into singleuser/.env, preserving existing keys."""
    data = read_env_file()
    data.update({k: str(v) for k, v in updates.items()})
    lines = ["# Single-user AI Data Conversion Studio config — managed by the setup wizard.",
             "# Do not commit this file; it holds your Claude API key."]
    lines += ["%s=%s" % (k, v) for k, v in data.items()]
    path = env_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
