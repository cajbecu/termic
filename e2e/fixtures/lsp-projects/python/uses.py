from models import Store, store_by_id


def describe_store(s: Store) -> str:
    return s.name


first = store_by_id(1)
