"""Order processing."""
from .auth import validate_token
from .db import get_database
from .payments import charge_card


class Order:
    def __init__(self, user, items):
        self.user = user
        self.items = items

    def total(self):
        return sum(price for _, price in self.items)


class PriorityOrder(Order):
    """Orders that skip the queue."""

    def total(self):
        return super().total() * 1.1


def place_order(token, items):
    """Place an order for an authenticated user."""
    if not validate_token(token):
        raise PermissionError("invalid token")
    order = Order(token, items)
    charge_card(token, order.total())
    return get_database().insert("orders", {"user": token, "items": items})
