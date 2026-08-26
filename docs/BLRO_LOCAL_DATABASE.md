# BLRO Local Database (development)

How to stand up the PostgreSQL that BLRO's authoritative stores need, **without root**.

This is a development/verification database. Production topology is a separate decision — see
[BLRO Operations Runbook](BLRO_OPERATIONS_RUNBOOK.md) and the
[separation plan](design-docs/blro-separation-and-operations.md).

## Why rootless

The verified workstation had no passwordless `sudo`, so `apt install postgresql` was impossible,
and the EnterpriseDB binary download is blocked (HTTP 403). A user-space server needs no root, is
trivially disposable, and cannot disturb a system service. The `pgserver` pypi package bundles
PostgreSQL binaries for linux x86-64.

## Install and start

```bash
uv venv /tmp/pgvenv
uv pip install --python /tmp/pgvenv/bin/python pgserver

export PGDATA="$HOME/.local/share/blro-pg/data"
export PATH="/tmp/pgvenv/lib/python3.12/site-packages/pgserver/pginstall/bin:$PATH"

# first run initialises the cluster
/tmp/pgvenv/bin/python -c "
import pgserver, pathlib
d = pathlib.Path.home() / '.local/share/blro-pg/data'
d.mkdir(parents=True, exist_ok=True)
pgserver.get_server(str(d))
"
```

Verified: **PostgreSQL 16.2 on x86_64-pc-linux-gnu**.

Enable loopback TCP (Prisma needs a TCP URL; the bundled server defaults to a Unix socket). Port
`55432` is used to avoid colliding with any system Postgres:

```bash
grep -q '^port = 55432' "$PGDATA/postgresql.conf" || {
  echo "listen_addresses = '127.0.0.1'" >> "$PGDATA/postgresql.conf"
  echo "port = 55432"                   >> "$PGDATA/postgresql.conf"
}
grep -q 'blro-tcp' "$PGDATA/pg_hba.conf" || {
  printf '# blro-tcp\nhost    all    all    127.0.0.1/32    trust\n' >> "$PGDATA/pg_hba.conf"
}
pg_ctl -D "$PGDATA" -o "-k $PGDATA" -w restart
pg_isready -h 127.0.0.1 -p 55432
```

`trust` on `127.0.0.1` is acceptable **only** for a local development cluster that holds no
customer data. Never use it for anything reachable off the loopback interface.

## Roles: why two, and why the app role is deliberately weak

Row-level security is **bypassed by superusers, and by the table owner unless the table is
`FORCE`d**. So the runtime must connect as a role that is neither.

```bash
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres <<'SQL'
CREATE ROLE blro_owner LOGIN PASSWORD 'blro_owner_local';
CREATE ROLE blro_app   LOGIN PASSWORD 'blro_app_local'
  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE blro OWNER blro_owner;
SQL

psql -h 127.0.0.1 -p 55432 -U postgres -d blro <<'SQL'
GRANT CONNECT ON DATABASE blro TO blro_app;
GRANT USAGE ON SCHEMA public TO blro_app;
ALTER DEFAULT PRIVILEGES FOR ROLE blro_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO blro_app;
SQL
```

Verify the guarantee rather than assuming it:

```bash
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres \
  -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'blro%';"
```

Observed: `blro_app` and `blro_owner` both `rolsuper=f`, `rolbypassrls=f`.

## Apply the schema

Migrations run as the **owner**; the application never does DDL.

```bash
for migration in \
  prisma/migrations/20260812101700_blro_scope_rls/migration.sql \
  prisma/migrations/20260812150000_blro_authority_stores/migration.sql \
  prisma/migrations/20260826170000_blro_runtime_stores/migration.sql; do
  PGPASSWORD=blro_owner_local psql -h 127.0.0.1 -p 55432 -U blro_owner -d blro \
    -v ON_ERROR_STOP=1 -f "$migration"
done
```

## Verify isolation

```bash
export DATABASE_URL="postgresql://blro_app:blro_app_local@127.0.0.1:55432/blro"
pnpm run verify:rls        # expect: BLRO_RLS_ISOLATION_PASS (3 scoped tables)
pnpm test                  # database-backed suites run instead of skipping
```

Observed behaviour on the live cluster:

| Scenario | Result |
|---|---|
| Session scoped to `proj-a` | sees only `proj-a` rows; **0** rows of `proj-b` |
| **No scope set** | **0 rows** — fail-closed, not "everything" |
| Same nonce value in two projects | independent |
| Insert row for `proj-b` while scoped to `proj-a` | `ERROR: new row violates row-level security policy` |

## Working with RLS in application code

The policy reads `current_setting('app.project_id', true)`, so **the scope must be set on the same
transaction as the query**:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
  // ... queries here see exactly this project
});
```

An unscoped write is refused with SQLSTATE `42501`, and an unscoped read returns zero rows. That is
the enforcement working. Never "fix" it by granting `BYPASSRLS` or by dropping `FORCE`.

`SET LOCAL` outside a transaction block is a no-op that only emits a warning — a real pitfall,
since the surrounding statements then run with no scope at all.

## Stop, reset, remove

```bash
pg_ctl -D "$PGDATA" -m fast stop          # stop
rm -rf "$HOME/.local/share/blro-pg"       # destroy the cluster and all local data
rm -rf /tmp/pgvenv                        # remove the bundled binaries
```

The credentials above are local development values with no production meaning. Real deployments
inject credentials from the platform secret manager and never use `trust` authentication.
