#pragma once
#include <string>

// The definition every check in the smoke harness aims at.
struct Store {
  std::string name;
};

struct StoreAdmin {
  Store store;
};

Store StoreByID(int id);
