package stores

type Store struct {
	Name string
}

type StoreAdmin struct {
	Store Store
}

func StoreByID(id int) *Store {
	return &Store{Name: "store"}
}
