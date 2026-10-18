"""FastAPI ASGI entrypoint for Vercel and production deployments."""
from nexmind.main import app

__all__ = ["app"]
