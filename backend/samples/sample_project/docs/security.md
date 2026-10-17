# Security Notes

Passwords must be hashed before storage. The demo uses SHA-256 which is not suitable for production;
use bcrypt or Argon2 instead. Session tokens should expire. The `validate_token` check only inspects the format.

Payment data must never be logged. The audit log records only the amount and the user.
PostgreSQL should be configured with TLS. Security reviews are required before release.
