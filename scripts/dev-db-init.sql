-- Runs once, when the dev database volume is first created (compose.dev.yaml mounts it into
-- /docker-entrypoint-initdb.d/). `npm run dev:demo` and `npm run demo:reset` use this database so they never
-- touch `expenses`, which holds the real dev data.
CREATE DATABASE expenses_demo OWNER expenses;
