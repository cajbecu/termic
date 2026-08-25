export class Store {
  constructor(public name: string) {}
}

export class StoreAdmin {
  constructor(public store: Store) {}
}

export function storeById(id: number): Store {
  return new Store(`store-${id}`);
}
