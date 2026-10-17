"""Authentication: password hashing and token validation."""
import hashlib

from .db import get_database


def hash_password(password: str) -> str:
    """Hash a password with SHA-256 (demo only)."""
    return hashlib.sha256(password.encode()).hexdigest()


def create_user(name: str, password: str) -> int:
    """Create a user account and return its id."""
    db = get_database()
    return db.insert("users", {"name": name, "password": hash_password(password)})


def validate_token(token: str) -> bool:
    """Check that a session token is well formed."""
    return token.startswith("tok_") and len(token) > 8


def login(name: str, password: str) -> str:
    """Authenticate a user and return a session token."""
    db = get_database()
    users = db.find("users", name=name, password=hash_password(password))
    if not users:
        raise ValueError("bad credentials")
    return "tok_" + name
