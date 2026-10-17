# Shop Architecture

The shop is a small demo application built with Python and a JavaScript front end.

## Authentication

Users register with `create_user` and sign in through `login`, which returns a session token.
Tokens are verified by `validate_token` before any order is accepted. Passwords are hashed in `hash_password`.
See `shop/auth.py` for details. Session tokens use the prefix tok_.

## Orders and payments

`place_order` creates an Order, charges the customer through `charge_card` and stores the order in the Database.
Priority customers get a PriorityOrder with a surcharge. Payment events are written to the audit log by `audit`.

## Storage

The Database class keeps everything in memory. Use `get_database` to obtain the shared instance.
In production the Database would be replaced by PostgreSQL.
