public struct Store {
    public let name: String
    public init(name: String) { self.name = name }
}

public struct StoreAdmin {
    public let store: Store
}

public func storeByID(_ id: Int) -> Store {
    Store(name: "store")
}
