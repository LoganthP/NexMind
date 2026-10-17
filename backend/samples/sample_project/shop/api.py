"""HTTP layer."""
from .auth import login, create_user
from .orders import place_order


def register_handler(request):
    return create_user(request["name"], request["password"])


def login_handler(request):
    return login(request["name"], request["password"])


def order_handler(request):
    return place_order(request["token"], request["items"])


def main():
    print(login_handler({"name": "a", "password": "b"}))


if __name__ == "__main__":
    main()
