"""Start NexMind:  python run.py   (reads NEXMIND_HOST / NEXMIND_PORT from .env)"""
import uvicorn

from nexmind.config import settings

if __name__ == "__main__":
    uvicorn.run("nexmind.main:app", host=settings.host, port=settings.port, reload=False, log_level="info")
