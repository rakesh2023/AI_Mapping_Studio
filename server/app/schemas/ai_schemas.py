"""JSON schemas for Claude structured output.

These are passed to the Anthropic API as output_config.format json_schema so
the model returns validated JSON. Kept verbatim from the original monolith so
request/response shapes are unchanged.

    MAPPING_ITEM_SCHEMA   -> POST /api/ai/generate-mappings (bulk mappings + joins)
    SINGLE_MAPPING_SCHEMA -> POST /api/ai/regenerate-mapping (one field)
    SOURCE_EXTRACT_SCHEMA -> POST /api/ai/extract-source[-stream] (file -> tables)
"""

MAPPING_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "mappings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "targetEntity": {"type": "string"},
                    "targetColumn": {"type": "string"},
                    "sourceTable": {"type": "string"},
                    "sourceColumn": {"type": "string"},
                    "mappingType": {"type": "string", "enum": [
                        "Direct", "Derived", "Lookup", "Conditional", "Constant",
                        "Default", "Concatenation", "Split", "Format Conversion",
                        "Data Type Conversion", "Calculation", "Aggregation",
                        "Reference", "Custom", "Not Mapped"]},
                    "transformationRule": {"type": "string"},
                    "businessRule": {"type": "string"},
                    "nullHandling": {"type": "string"},
                    "confidence": {"type": "integer"},
                    "explanation": {"type": "string"},
                },
                "required": ["targetEntity", "targetColumn", "sourceTable", "sourceColumn",
                             "mappingType", "transformationRule", "businessRule",
                             "nullHandling", "confidence", "explanation"],
                "additionalProperties": False,
            },
        },
        "joins": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "targetEntity": {"type": "string"},
                    "joinCondition": {"type": "string"},
                },
                "required": ["targetEntity", "joinCondition"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["mappings", "joins"],
    "additionalProperties": False,
}


SINGLE_MAPPING_SCHEMA = {
    "type": "object",
    "properties": {
        "sourceTable": {"type": "string"},
        "sourceColumn": {"type": "string"},
        "mappingType": {"type": "string", "enum": [
            "Direct", "Derived", "Lookup", "Conditional", "Constant", "Default",
            "Concatenation", "Split", "Format Conversion", "Data Type Conversion",
            "Calculation", "Aggregation", "Reference", "Custom", "Not Mapped"]},
        "transformationRule": {"type": "string"},
        "businessRule": {"type": "string"},
        "lookupTable": {"type": "string"},
        "defaultValue": {"type": "string"},
        "nullHandling": {"type": "string"},
        "confidence": {"type": "integer"},
        "explanation": {"type": "string"},
        "joinCondition": {"type": "string"},
    },
    "required": ["sourceTable", "sourceColumn", "mappingType", "transformationRule",
                 "businessRule", "nullHandling", "confidence", "explanation"],
    "additionalProperties": False,
}


MATCH_TABLES_SCHEMA = {
    "type": "object",
    "properties": {
        "matches": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "target": {"type": "string"},
                    "match": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["target", "match", "confidence"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["matches"],
    "additionalProperties": False,
}


INFER_TARGET_META_SCHEMA = {
    "type": "object",
    "properties": {
        "columns": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "pk": {"type": "boolean"},
                    "fk": {"type": "boolean"},
                    "fkReference": {"type": "string"},
                    "isListTable": {"type": "boolean"},
                    "description": {"type": "string"},
                },
                "required": ["name", "description"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["columns"],
    "additionalProperties": False,
}


SOURCE_EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "tables": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "columns": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "dataType": {"type": "string"},
                                "length": {"type": ["integer", "null"]},
                                "businessTerm": {"type": "string"},
                                "description": {"type": "string"},
                                "sample": {"type": "string"},
                            },
                            "required": ["name", "dataType"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["name", "columns"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["tables"],
    "additionalProperties": False,
}


# Lookup-document extraction: pull SOURCE coded column -> TARGET column bindings and
# their code/description values from an unstructured file (PDF / Word / messy sheet).
LOOKUP_EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "sets": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "lookupName": {"type": "string"},
                    "sourceTable": {"type": "string"},
                    "sourceColumn": {"type": "string"},
                    "targetTable": {"type": "string"},
                    "targetColumn": {"type": "string"},
                    "expectedValues": {"type": "string"},
                    "values": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "code": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["code"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    "required": ["sets"],
    "additionalProperties": False,
}


# Rich file extraction (opt-in "Use AI extraction" on the Target upload): like
# SOURCE_EXTRACT_SCHEMA but also asks the AI to read a data dictionary's key/flag
# columns and infer mandatory, primary key, foreign key + the referenced table.column.
RICH_EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "tables": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "columns": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "dataType": {"type": "string"},
                                "length": {"type": ["integer", "null"]},
                                "mandatory": {"type": "boolean"},
                                "pk": {"type": "boolean"},
                                "fk": {"type": "boolean"},
                                "fkReference": {"type": ["string", "null"]},
                                "businessTerm": {"type": "string"},
                                "description": {"type": "string"},
                                "sample": {"type": "string"},
                            },
                            "required": ["name", "dataType"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["name", "columns"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["tables"],
    "additionalProperties": False,
}


# One new target ENTITY (table + its columns) parsed from a natural-language
# instruction (POST /api/ai/parse-entity). confidence 0 means "could not parse".
ENTITY_SCHEMA = {
    "type": "object",
    "properties": {
        "entity": {"type": "string"},
        "table": {"type": "string"},
        "description": {"type": "string"},
        "isListTable": {"type": "boolean"},
        "columns": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "dataType": {"type": "string"},
                    "length": {"type": ["integer", "null"]},
                    "mandatory": {"type": "boolean"},
                    "pk": {"type": "boolean"},
                    "fk": {"type": "boolean"},
                    "fkReference": {"type": ["string", "null"]},
                    "description": {"type": "string"},
                },
                "required": ["name", "dataType"],
                "additionalProperties": False,
            },
        },
        "confidence": {"type": "integer"},
        "note": {"type": "string"},
    },
    "required": ["entity", "columns", "confidence"],
    "additionalProperties": False,
}


# One new target column parsed from a natural-language instruction
# (POST /api/ai/parse-column). confidence 0 means "could not confidently parse".
COLUMN_SCHEMA = {
    "type": "object",
    "properties": {
        "column": {"type": "string"},
        "dataType": {"type": "string"},
        "length": {"type": ["integer", "null"]},
        "mandatory": {"type": "boolean"},
        "pk": {"type": "boolean"},
        "fk": {"type": "boolean"},
        "fkReference": {"type": ["string", "null"]},
        "afterColumn": {"type": ["string", "null"]},
        "description": {"type": "string"},
        "confidence": {"type": "integer"},
        "note": {"type": "string"},
    },
    "required": ["column", "dataType", "mandatory", "pk", "fk", "confidence"],
    "additionalProperties": False,
}


# ONE OR MORE new target columns parsed from a natural-language instruction
# (POST /api/ai/parse-column). The user may describe several columns at once.
COLUMNS_SCHEMA = {
    "type": "object",
    "properties": {
        "columns": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "column": {"type": "string"},
                    "dataType": {"type": "string"},
                    "length": {"type": ["integer", "null"]},
                    "mandatory": {"type": "boolean"},
                    "pk": {"type": "boolean"},
                    "fk": {"type": "boolean"},
                    "fkReference": {"type": ["string", "null"]},
                    "afterColumn": {"type": ["string", "null"]},
                    "description": {"type": "string"},
                },
                "required": ["column", "dataType", "mandatory", "pk", "fk"],
                "additionalProperties": False,
            },
        },
        "confidence": {"type": "integer"},
        "note": {"type": "string"},
    },
    "required": ["columns", "confidence"],
    "additionalProperties": False,
}

# Know Your Data — insurance domain classifier (kyd_domain_service).
DOMAIN_CHECK_SCHEMA = {
    "type": "object",
    "properties": {
        "is_insurance_related": {"type": "boolean"},
        "confidence": {"type": "number"},
        "detected_topics": {"type": "array", "items": {"type": "string"}},
        "reasoning": {"type": "string"},
    },
    "required": ["is_insurance_related", "confidence", "detected_topics", "reasoning"],
    "additionalProperties": False,
}

# Know Your Data — retrieval-strategy router (kyd_query_router).
ROUTE_QUERY_SCHEMA = {
    "type": "object",
    "properties": {
        "route": {"type": "string",
                  "enum": ["vector_search", "sql_query", "pandas_query", "hybrid"]},
        "target_sources": {"type": "array", "items": {"type": "string"}},
        "reasoning": {"type": "string"},
    },
    "required": ["route", "target_sources", "reasoning"],
    "additionalProperties": False,
}
