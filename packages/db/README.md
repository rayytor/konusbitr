# @konusbitr/db

Drizzle schema, migrations, and the tenancy-scoped database client.

Placeholder until **Phase 03 — Database Schema**. When it lands, this package
owns every table definition, every migration, and the `scopedDb(orgId)` helper
that all query paths must go through.

The Python worker never imports this package. The only contract between the two
runtimes is the Redis queue plus the JSON payloads defined in
`@konusbitr/shared`.
