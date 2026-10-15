import { defineConfig } from 'drizzle-kit';

/*
  Test databases only — this extension has no migrations of its own in production. Its tables are
  created the real way at install time, by kempo's createTablesFromSchema plus install.js.

  It lists every table the suites touch: this extension's, kempo's own and kempo-payments' (every
  charge is a kempo-payments payment, and its webhooks update that table). The unit tier builds its
  in-memory database from this list, and `npx drizzle-kit push` builds the integration tier's from it.

  No dotenv here on purpose. DATABASE_URL needs to be a real environment variable.
*/
export default defineConfig({
  schema: [
    './server/db/schema.js',
    './node_modules/kempo/server/db/schema.js',
    './node_modules/kempo-payments/server/db/schema.js',
  ],
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
