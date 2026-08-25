# frozen_string_literal: true

class Store
  attr_reader :name

  def initialize(name)
    @name = name
  end
end

class StoreAdmin
  def initialize(store)
    @store = store
  end
end
