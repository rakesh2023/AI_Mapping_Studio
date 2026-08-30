"""Tiny, dependency-free reader/writer for the single-user config file
(singleuser/.env). Kept separate from the app so run.py can use it BEFORE importing
the app package. NEVER touches server/.env — the multi-user app is unaffected.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, ".env")   # singleuser/.env — our own, isolated config


def read_env_file():
    """Return {KEY: value} from singleuser/.env ({} if absent)."""
    out = {}
    try:
        with open(ENV_PATH, "r", encoding="utf-8") as fh:
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
    with open(ENV_PATH, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
