#include "models.h"

// A USE of Store, in a different translation unit from its definition.
std::string describe(const Store &s) {
  return s.name;
}
