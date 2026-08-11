"""AI Mapping Studio backend package.

Layered architecture:
    core/       env & path config, optional-import capability guards
    schemas/    JSON schemas for Claude structured output
    parsers/    pure text/file parsing & chunking (no Flask, no Anthropic)
    services/   business logic (db, ai client, mapping, extraction)
    api/        thin Flask blueprints (parse request -> call service -> jsonify)

The Flask app factory (create_app) is added in a later migration step; until
then the monolithic app.py remains the authoritative entry point.
"""
