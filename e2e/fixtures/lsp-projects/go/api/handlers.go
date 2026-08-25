package api

import "example.com/lspfixture/stores"

func Describe(s *stores.Store) string {
	return s.Name
}
