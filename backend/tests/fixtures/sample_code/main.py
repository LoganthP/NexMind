"""Main application entry point."""
from utils import calculate_tax, format_currency
from service import OrderService

def run_app():
    service = OrderService()
    total = service.process_order(100.0)
    tax = calculate_tax(total)
    print(f"Total: {format_currency(total + tax)}")

if __name__ == "__main__":
    run_app()
