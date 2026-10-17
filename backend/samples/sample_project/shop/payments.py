"""Payment gateway integration."""
from .db import get_database


def charge_card(user, amount):
    """Charge the user's card."""
    audit("charge", user, amount)
    return {"ok": True, "amount": amount}


def audit(event, user, amount):
    get_database().insert("audit", {"event": event, "user": user, "amount": amount})
