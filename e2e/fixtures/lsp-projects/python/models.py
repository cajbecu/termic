class Store:
    def __init__(self, name: str) -> None:
        self.name = name


class StoreAdmin:
    def __init__(self, store: Store) -> None:
        self.store = store


def store_by_id(store_id: int) -> Store:
    return Store(f"store-{store_id}")
