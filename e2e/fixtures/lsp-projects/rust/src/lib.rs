pub struct Store {
    pub name: String,
}

pub struct StoreAdmin {
    pub store: Store,
}

pub fn store_by_id(id: u32) -> Store {
    Store { name: format!("store-{id}") }
}

pub fn uses_store() -> String {
    let s = store_by_id(1);
    s.name
}
