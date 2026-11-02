-- 022_database_rbac.sql
-- Additive database RBAC. Existing tables and rows are preserved.
-- The app connects as thriftflip_app (NOINHERIT), then SET LOCAL ROLE selects
-- one of these non-login roles for each request/query.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thriftflip_student') THEN
    CREATE ROLE thriftflip_student NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thriftflip_admin') THEN
    CREATE ROLE thriftflip_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thriftflip_auth') THEN
    CREATE ROLE thriftflip_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thriftflip_fn_owner') THEN
    CREATE ROLE thriftflip_fn_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

ALTER ROLE thriftflip_student NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE thriftflip_admin NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE thriftflip_auth NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE thriftflip_fn_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

GRANT USAGE ON SCHEMA public TO thriftflip_student, thriftflip_admin, thriftflip_auth;

-- Admin operations. No superuser, role-management, or database-creation powers.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO thriftflip_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO thriftflip_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO thriftflip_admin;

-- Student application operations. Sensitive administration tables and migration
-- bookkeeping are explicitly excluded below; row ownership is enforced by RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO thriftflip_student;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO thriftflip_student;
REVOKE ALL ON TABLE admin, admin_action, schema_migrations FROM thriftflip_student;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE admin_message TO thriftflip_student;
GRANT SELECT, INSERT ON TABLE report TO thriftflip_student;
REVOKE ALL ON TABLE auth_token FROM thriftflip_student;
REVOKE ALL ON SEQUENCE admin_admin_id_seq FROM thriftflip_student;

-- Unauthenticated requests are limited to account sign-in/registration and the
-- catalogue/reference data needed by public pages. Password hashes are only read
-- by the server-side authentication service, never returned by API routes.
GRANT SELECT ON TABLE student, admin TO thriftflip_auth;
GRANT INSERT ON TABLE student TO thriftflip_auth;
GRANT USAGE, SELECT ON SEQUENCE student_student_id_seq TO thriftflip_auth;
GRANT SELECT ON TABLE campus, department, course, college_email_domain, book,
  listing, listing_image, v_listing_details, v_auction_status, v_student_ratings TO thriftflip_auth;
GRANT EXECUTE ON FUNCTION create_auth_token(INTEGER, TEXT, TEXT, INTEGER) TO thriftflip_auth;
GRANT EXECUTE ON FUNCTION reset_student_password(TEXT, TEXT) TO thriftflip_auth;

-- Row-level protection for student-owned records that are written only by their owner.
-- Cross-user system-triggered tables (notifications and price_alert) are intentionally
-- excluded because existing triggers legitimately write on behalf of other students.
-- The application sets these transaction-local values from its signed, httpOnly cookie.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wishlist','recently_viewed','search_activity','student_wanted_book'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_student_own_rows', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO thriftflip_student USING (student_id = NULLIF(current_setting(''app.user_id'', true), '''')::INTEGER) WITH CHECK (student_id = NULLIF(current_setting(''app.user_id'', true), '''')::INTEGER)',
      t || '_student_own_rows', t
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_admin_all_rows', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO thriftflip_admin USING (true) WITH CHECK (true)', t || '_admin_all_rows', t);
  END LOOP;
END $$;

-- Auth-token table access is mediated only by these fixed-purpose functions.
-- Their owner is a dedicated non-login role, not the superuser or app login.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE student, auth_token TO thriftflip_fn_owner;
GRANT CREATE ON SCHEMA public TO thriftflip_fn_owner;
ALTER FUNCTION create_auth_token(INTEGER, TEXT, TEXT, INTEGER) OWNER TO thriftflip_fn_owner;
ALTER FUNCTION reset_student_password(TEXT, TEXT) OWNER TO thriftflip_fn_owner;
REVOKE CREATE ON SCHEMA public FROM thriftflip_fn_owner;
ALTER FUNCTION create_auth_token(INTEGER, TEXT, TEXT, INTEGER) SECURITY DEFINER;
REVOKE ALL ON FUNCTION create_auth_token(INTEGER, TEXT, TEXT, INTEGER) FROM PUBLIC;
ALTER FUNCTION create_auth_token(INTEGER, TEXT, TEXT, INTEGER) SET search_path = public, pg_temp;
ALTER FUNCTION reset_student_password(TEXT, TEXT) SECURITY DEFINER;
REVOKE ALL ON FUNCTION reset_student_password(TEXT, TEXT) FROM PUBLIC;
ALTER FUNCTION reset_student_password(TEXT, TEXT) SET search_path = public, pg_temp;

ALTER TABLE admin_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_message FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_message_student_own_rows ON admin_message;
CREATE POLICY admin_message_student_own_rows ON admin_message
  FOR ALL TO thriftflip_student
  USING (student_id = NULLIF(current_setting('app.user_id', true), '')::INTEGER)
  WITH CHECK (student_id = NULLIF(current_setting('app.user_id', true), '')::INTEGER);
DROP POLICY IF EXISTS admin_message_admin_all_rows ON admin_message;
CREATE POLICY admin_message_admin_all_rows ON admin_message
  FOR ALL TO thriftflip_admin USING (true) WITH CHECK (true);

ALTER TABLE report ENABLE ROW LEVEL SECURITY;
ALTER TABLE report FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_student_own_rows ON report;
CREATE POLICY report_student_own_rows ON report
  FOR ALL TO thriftflip_student
  USING (reporter_id = NULLIF(current_setting('app.user_id', true), '')::INTEGER)
  WITH CHECK (reporter_id = NULLIF(current_setting('app.user_id', true), '')::INTEGER);
DROP POLICY IF EXISTS report_admin_all_rows ON report;
CREATE POLICY report_admin_all_rows ON report
  FOR ALL TO thriftflip_admin USING (true) WITH CHECK (true);
