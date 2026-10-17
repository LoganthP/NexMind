"""Pytest configuration: ensures every test session runs in an isolated temp data directory with offline LLM."""
import os
import shutil
import tempfile
import pytest

_TEST_DATA_DIR = tempfile.mkdtemp(prefix="nexmind-test-session-")
os.environ["NEXMIND_DATA_DIR"] = _TEST_DATA_DIR
os.environ["NEXMIND_STREAM_DELAY"] = "0"
os.environ["NEXMIND_LLM_PROVIDER"] = "offline"

# Now import nexmind to initialize settings with the temp directory
from nexmind.config import settings
from nexmind.state import db, store, jobs

@pytest.fixture(scope="session", autouse=True)
def test_environment_lifecycle():
    yield
    shutil.rmtree(_TEST_DATA_DIR, ignore_errors=True)
