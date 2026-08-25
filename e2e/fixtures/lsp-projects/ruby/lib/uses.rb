# frozen_string_literal: true

require_relative "models"

# A USE of Store, in a different file from its definition.
def describe(store)
  Store.new(store.name).name
end
