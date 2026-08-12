"""AI Mapping Studio backend package.

Layered architecture:
    core/       env & path config, optional-import capability guards
    schemas/    JSON schemas for Claude structured output
    parsers/    pure text/file parsing & chunking (no Flask, no Anthropic)
    services/   business logic (db, ai client, mapping, extraction)
    api/        thin Flask blueprints (parse request -> call service -> jsonify)

create_app() builds the Flask app and registers the three blueprints. A
module-level `app` instance is exposed so main.py / WSGI can import it.
"""
from flask import Flask


def create_app() -> Flask:
    """Application factory: build the Flask app and register all blueprints."""
    application = Flask(__name__, static_folder=None)

    from app.api.static_routes import bp as static_bp
    from app.api.db_routes import bp as db_bp
    from app.api.ai_routes import bp as ai_bp
    from app.api.deploy_routes import bp as deploy_bp
    from app.api.ai_usage import bp as ai_usage_bp

    application.register_blueprint(static_bp)
    application.register_blueprint(db_bp)
    application.register_blueprint(ai_bp)
    application.register_blueprint(deploy_bp)
    application.register_blueprint(ai_usage_bp)

    # Create the local AI-usage-log table if missing (idempotent, non-fatal).
    from app.services.ai_usage_logger import ensure_usage_table
    ensure_usage_table()
    return application


app = create_app()
