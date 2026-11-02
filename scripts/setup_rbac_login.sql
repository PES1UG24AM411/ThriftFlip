-- Run this once as the existing PostgreSQL superuser AFTER migration 022.
-- It creates the non-superuser login used by the Next.js application.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thriftflip_app') THEN
    CREATE ROLE thriftflip_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE thriftflip_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT thriftflip_student, thriftflip_admin, thriftflip_auth TO thriftflip_app;
