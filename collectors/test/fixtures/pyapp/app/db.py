"""Database helpers."""
import psycopg2

CACHE = {}
MAX_ROWS = 100


def connect():
    return psycopg2.connect("dbname=shop")


def get_user(user_id: int) -> dict:
    """Load one user, cached."""
    if user_id in CACHE:
        return CACHE[user_id]
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
    row = cur.fetchone()
    CACHE[user_id] = row
    return row


def save_user(user: dict) -> None:
    conn = connect()
    conn.cursor().execute("INSERT INTO users VALUES (%s)", (user,))
