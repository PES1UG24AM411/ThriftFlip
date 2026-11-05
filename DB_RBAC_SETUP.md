# ThriftFlip PostgreSQL RBAC Setup

This guide explains how to enable PostgreSQL Role-Based Access Control (RBAC) in ThriftFlip.

**Important:** This is an additive security setup. It does not drop, truncate, recreate, or reset existing tables or data. The supplied Docker Compose configuration maps PostgreSQL to host port `5433`.

## 1. What the RBAC Setup Adds

The migration introduces the following PostgreSQL roles:

| Role | Purpose |
|---|---|
| `thriftflip_student` | Restricted permissions for student operations. |
| `thriftflip_admin` | Administrative database permissions. |
| `thriftflip_auth` | Limited permissions for registration and authentication. |
| `thriftflip_fn_owner` | Restricted owner of two fixed-purpose password-token functions. |
| `thriftflip_app` | Non-superuser login used by the Next.js application. |

### Row-Level Security (RLS)

RLS policies restrict access to individual students' records in the following tables:

- Wishlist records
- Recently viewed items
- Search activity
- Wanted-book records
- Report records
- Admin-message records

Students can access their own protected records, while the administrator role can access all records in these protected tables.

**Notifications and price alerts are intentionally excluded.** Existing database triggers create or update these records on behalf of other students during valid marketplace operations.

The existing `thriftflip` account remains the database owner and is used for migrations and maintenance.

## 2. Prerequisites

Before applying the setup, ensure that:

- PostgreSQL is running through Docker Compose.
- The `thriftflip-db` container exists and is running.
- The project dependencies have been installed.
- The existing `DATABASE_URL` connects using the database owner account.
- You are working in the project root directory.

Check the database container:

```bash
docker ps --filter name=thriftflip-db
```

## 3. Apply RBAC Safely

### Step 1: Back Up the Existing Database

Create a backup before applying the migration:

```bash
docker exec thriftflip-db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > thriftflip_before_rbac.sql
```

Verify that the backup file exists:

```bash
ls -lh thriftflip_before_rbac.sql
```

Keep this backup in a safe location.

### Step 2: Apply the RBAC Migration

Run the migration using the existing database owner connection:

```bash
npm run db:migrate
```

This applies pending migration files, including `022_database_rbac.sql`, without resetting existing data.

### Step 3: Create the Application Login

Run the supplied SQL setup script:

```bash
docker exec -i thriftflip-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/setup_rbac_login.sql
```

This creates the `thriftflip_app` login and grants membership in the student, administrator, and authentication roles.

### Step 4: Set the Application Password

Open a PostgreSQL interactive session:

```bash
docker exec -it thriftflip-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Generate a strong password:

```bash
openssl rand -hex 24
```

At the PostgreSQL prompt, set the password:

```sql
\password thriftflip_app
```

Enter the generated password when prompted, then exit:

```sql
\q
```

Do not commit the password or store it in source-controlled files.

### Step 5: Configure the Application Connection

Add `APP_DATABASE_URL` to `.env.local`:

```env
APP_DATABASE_URL=postgresql://thriftflip_app:YOUR_APP_PASSWORD@localhost:5433/thriftflip
```

Replace `YOUR_APP_PASSWORD` with the password configured in Step 4.

**Keep `DATABASE_URL` unchanged.** It remains the owner connection for migrations and maintenance scripts.

### Step 6: Restart the Application

Restart the Next.js development server:

```bash
npm run dev
```

The application pool should connect through `thriftflip_app` and select the appropriate database role for each request based on the signed session cookie.

## 4. Verify the RBAC Configuration

Run the following SQL using the database owner account to check that the roles exist:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin
FROM pg_roles
WHERE rolname IN (
    'thriftflip_student',
    'thriftflip_admin',
    'thriftflip_auth',
    'thriftflip_fn_owner',
    'thriftflip_app'
)
ORDER BY rolname;
```

The application login should have `rolcanlogin = true`, while the three application permission roles and function-owner role should be non-login roles.

Check the application login's role memberships:

```sql
SELECT
    member.rolname AS member_role,
    granted.rolname AS granted_role
FROM pg_auth_members m
JOIN pg_roles member ON member.oid = m.member
JOIN pg_roles granted ON granted.oid = m.roleid
WHERE member.rolname = 'thriftflip_app'
ORDER BY granted.rolname;
```

Check that RLS is enabled on the protected tables:

```sql
SELECT
    tablename,
    rowsecurity,
    forcerowsecurity
FROM pg_tables
WHERE schemaname = 'public'
AND tablename IN (
    'wishlist',
    'recently_viewed',
    'search_activity',
    'student_wanted_book',
    'report',
    'admin_message'
)
ORDER BY tablename;
```

Review the configured policies:

```sql
SELECT
    tablename,
    policyname,
    roles,
    cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

These checks inspect the configuration; they do not modify database records.

## 5. Important Security Notes

- Do not change `DATABASE_URL`. It remains the owner connection for migrations and maintenance.
- Use `APP_DATABASE_URL` for the Next.js application after completing the setup.
- Do not run `docker compose down -v`, `npm run db:reset`, or any command that deletes database volumes.
- Do not grant superuser privileges to `thriftflip_app`.
- RLS protects the listed personal-data tables. Other business rules continue to be enforced by existing API authorization, SQL functions, and database triggers.
- This migration does not claim that every database table is row-isolated.
- Passwords and database connection strings must not be committed to GitHub.

## 6. Troubleshooting

**Permission denied**

If the application reports a `permission denied` error:

1. Record the exact error message.
2. Identify the affected table or database operation.
3. Check the role used by the application connection.
4. Review the relevant grants and RLS policies.
5. Add only the specific missing privilege after verifying that it is required.

Do not resolve permission errors by granting superuser privileges or unrestricted table access.

**Application connection failure**

Check that:

- PostgreSQL is running.
- The port in `APP_DATABASE_URL` matches the Docker Compose configuration.
- The database name is correct.
- The `thriftflip_app` password is correct.
- The application is using `APP_DATABASE_URL` rather than the owner connection.

**Migration failure**

Stop and inspect the migration error before retrying. Do not reset the database or delete its volume to resolve a migration problem.

---

**Result:** ThriftFlip uses separate PostgreSQL roles for student, administrator, and authentication operations, with row-level security for the specified student-owned records. The existing database and its data are preserved.
