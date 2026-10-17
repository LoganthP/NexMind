class OrderService:
    """Handles checkout and discount logic."""
    def __init__(self, discount: float = 0.10):
        self.discount = discount

    def process_order(self, subtotal: float) -> float:
        return subtotal * (1.0 - self.discount)
