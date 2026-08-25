from models import Store

# A type error on purpose: proves diagnostics still reach the editor.
wrong: Store = 42

# An undefined name on purpose.
missing = this_name_does_not_exist
