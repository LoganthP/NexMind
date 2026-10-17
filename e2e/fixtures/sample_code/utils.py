def calculate_tax(amount: float, rate: float = 0.08) -> float:
    return round(amount * rate, 2)

def format_currency(amount: float) -> str:
    return f"${amount:,.2f}"
