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
