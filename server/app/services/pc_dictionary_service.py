"""Per-client PolicyCenter dictionary index.

Thin wrapper over cc_dictionary_service: PolicyCenter uses the SAME Guidewire
`entityModel.xml` parser (physical pc_/pctl_ table names come straight from the XML),
so the only difference is which table set the rows live in — the `pc_dict_*` tables.
Every function delegates to cc_dictionary_service with prefix="pc_dict".

Built when a client's Product is Policy and they upload a PolicyCenter dictionary .zip on
Product Data Dictionary. Powers the Data Reconciliation page's grounded NL->SQL for the
"policycenter" source.
"""
from typing import Any, Dict, List, Optional

from app.services import cc_dictionary_service as _core

PREFIX = "pc_dict"


def build_from_zip(user_id: int, client_id: int, raw: bytes) -> Dict[str, Any]:
    return _core.build_from_zip(user_id, client_id, raw, prefix=PREFIX)


def has_index(user_id: int, client_id: int) -> Optional[Dict[str, int]]:
    return _core.has_index(user_id, client_id, prefix=PREFIX)


def list_tables(user_id: int, client_id: int, q: str = "", limit: int = 500) -> List[Dict[str, Any]]:
    return _core.list_tables(user_id, client_id, q, limit, prefix=PREFIX)


def catalog(user_id: int, client_id: int) -> List[Dict[str, str]]:
    return _core.catalog(user_id, client_id, prefix=PREFIX)


def search_entity_ids(user_id: int, client_id: int, prompt: str, limit: int = 15) -> List[str]:
    return _core.search_entity_ids(user_id, client_id, prompt, limit, prefix=PREFIX)


def schema_context(user_id: int, client_id: int, entity_ids: List[str], max_tables: int = 20) -> str:
    return _core.schema_context(user_id, client_id, entity_ids, max_tables, prefix=PREFIX)
