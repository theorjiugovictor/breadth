import requests
from .db import get_user, save_user
from . import db


class UserService:
    """Business logic for users."""

    def __init__(self, base_url: str):
        self.base_url = base_url

    def load(self, user_id: int) -> dict:
        user = get_user(user_id)
        self.enrich(user)
        return user

    def enrich(self, user):
        resp = requests.get(f"{ORDERS_URL}/orders?user={user['id']}")
        return resp.json()

    def load_many(self, ids: list[int]) -> list[dict]:
        return [self.load(i) for i in ids]


def factorial(n: int) -> int:
    return 1 if n <= 1 else n * factorial(n - 1)


def main():
    svc = UserService("http://orders:8000")
    for i in range(3):
        svc.load(i)
    db.save_user({"id": 1})


if __name__ == "__main__":
    main()
