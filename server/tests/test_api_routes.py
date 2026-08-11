"""Route-level tests: verify the blueprints wire URLs to services and pass the
(payload, status) through. Services are mocked so this tests routing only.
"""
import io
import json

import pytest

from app import create_app
from app.api import db_routes, ai_routes


@pytest.fixture
def client():
    return create_app().test_client()


def test_url_map_has_expected_rules(client):
    rules = {str(r.rule) for r in client.application.url_map.iter_rules()}
    for expected in [
        "/", "/<path:path>",
        "/api/db/drivers", "/api/db/test", "/api/db/metadata", "/api/db/profile",
        "/api/ai/status", "/api/ai/generate-mappings", "/api/ai/regenerate-mapping",
        "/api/ai/extract-source", "/api/ai/extract-source-stream",
    ]:
        assert expected in rules


def test_index_served(client):
    assert client.get("/").status_code == 200


def test_unknown_static_404(client):
    assert client.get("/does-not-exist.xyz").status_code == 404


def test_db_test_delegates_and_passes_status(client, monkeypatch):
    monkeypatch.setattr(db_routes.db_service, "test_connection",
                        lambda cfg: ({"ok": False, "error": "boom"}, 400))
    r = client.post("/api/db/test", json={"server": "x"})
    assert r.status_code == 400 and r.get_json()["error"] == "boom"


def test_db_metadata_delegates(client, monkeypatch):
    sentinel = {"ok": True, "tables": [], "tableCount": 0}
    monkeypatch.setattr(db_routes.db_service, "get_metadata", lambda cfg: (sentinel, 200))
    r = client.post("/api/db/metadata", json={})
    assert r.status_code == 200 and r.get_json() == sentinel


def test_ai_generate_delegates(client, monkeypatch):
    monkeypatch.setattr(ai_routes.mapping_service, "generate_mappings",
                        lambda body: ({"ok": True, "mappings": [], "returnedCount": 0}, 200))
    r = client.post("/api/ai/generate-mappings", json={"source": {}, "targetEntities": []})
    assert r.status_code == 200 and r.get_json()["ok"] is True


def test_ai_regenerate_delegates(client, monkeypatch):
    monkeypatch.setattr(ai_routes.mapping_service, "regenerate_mapping",
                        lambda body: ({"ok": True, "mapping": {"x": 1}}, 200))
    r = client.post("/api/ai/regenerate-mapping", json={"mapping": {"targetColumn": "C"}})
    assert r.status_code == 200 and r.get_json()["mapping"] == {"x": 1}


def test_extract_source_no_file_400(client):
    r = client.post("/api/ai/extract-source", data={}, content_type="multipart/form-data")
    assert r.status_code == 400 and r.get_json()["ok"] is False


def test_extract_source_delegates(client, monkeypatch):
    monkeypatch.setattr(ai_routes.extraction_service, "extract_source",
                        lambda filename, raw: ({"ok": True, "fileName": filename, "tableCount": 1}, 200))
    r = client.post("/api/ai/extract-source",
                    data={"file": (io.BytesIO(b"data"), "x.txt")},
                    content_type="multipart/form-data")
    assert r.status_code == 200 and r.get_json()["fileName"] == "x.txt"


def test_extract_stream_mimetype_and_events(client, monkeypatch):
    def fake_stream(filename, raw):
        yield json.dumps({"type": "start", "chunks": 1}) + "\n"
        yield json.dumps({"type": "done", "ok": True, "tableCount": 0}) + "\n"
    monkeypatch.setattr(ai_routes.extraction_service, "extract_source_stream", fake_stream)
    r = client.post("/api/ai/extract-source-stream",
                    data={"file": (io.BytesIO(b"data"), "x.txt")},
                    content_type="multipart/form-data")
    assert r.mimetype == "application/x-ndjson"
    events = [json.loads(l) for l in r.get_data(as_text=True).splitlines() if l.strip()]
    assert events[0]["type"] == "start" and events[-1]["type"] == "done"


def test_extract_stream_no_file_400(client):
    r = client.post("/api/ai/extract-source-stream", data={}, content_type="multipart/form-data")
    assert r.status_code == 400
