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
