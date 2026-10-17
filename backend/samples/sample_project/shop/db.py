"""Tiny in-memory database layer."""

_STORE = {}


class Database:
    """Key-value store used by the services."""

    def __init__(self):
        self.tables = {}

    def insert(self, table, row):
        self.tables.setdefault(table, []).append(row)
        return len(self.tables[table])

    def find(self, table, **filters):
        rows = self.tables.get(table, [])
        return [r for r in rows if all(r.get(k) == v for k, v in filters.items())]


def get_database():
    """Return the shared database instance."""
    if "db" not in _STORE:
        _STORE["db"] = Database()
    return _STORE["db"]
