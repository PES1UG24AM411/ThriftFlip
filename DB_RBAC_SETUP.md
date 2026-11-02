# ThriftFlip PostgreSQL RBAC setup

This is an additive setup. It does not drop, truncate, recreate, or reset any table or data. The supplied Docker Compose file maps PostgreSQL to host port `5433`.

## What it adds

- `thriftflip_student`, `thriftflip_admin`, and `thriftflip_auth`: non-login PostgreSQL roles with limited privileges; plus `thriftflip_fn_owner`, a restricted non-login owner for two fixed-purpose password-token functions.
- RLS policies that restrict each student's wishlist, recently viewed items, search activity, wanted books, report rows, and admin-message rows to that student's ID. Admin role can access all rows in those protected tables. Notifications and price alerts are intentionally excluded because existing database triggers update or create records on behalf of other students during valid marketplace events.
- `thriftflip_app`: a non-superuser login used by the Next.js application. The existing `thriftflip` account remains the owner/migration account.

## Apply safely

1. Back up the existing database first:

   ```bash
   docker exec thriftflip-db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > thriftflip_before_rbac.sql
   ```

2. Apply the new migration using the existing owner/superuser connection:

   ```bash
   npm run db:migrate
   ```

3. Create the application login and grant it membership in the three application roles:

   ```bash
   docker exec -i thriftflip-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/setup_rbac_login.sql
   ```

4. Set a password interactively (do not put it in shell history):

   ```bash
   docker exec -it thriftflip-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
   ```

   Generate a password using `openssl rand -hex 24`, then at the `psql` prompt run:

   ```sql
   \password thriftflip_app
   ```

5. Add `APP_DATABASE_URL` to `.env.local`, using the password you just set. Keep `DATABASE_URL` unchanged for migrations and maintenance:

   ```env
   APP_DATABASE_URL=postgresql://thriftflip_app:YOUR_APP_PASSWORD@localhost:5433/thriftflip
   ```

6. Restart the Next.js server. The app pool will now connect as `thriftflip_app` and select `thriftflip_student`, `thriftflip_admin`, or `thriftflip_auth` for each query based on the signed session cookie.

## Important

- Do not change `DATABASE_URL`; it remains the owner connection for migrations and scripts.
- Do not run `docker compose down -v`, `npm run db:reset`, or any volume deletion command.
- The RLS policies protect the listed personal-data tables. Other business rules continue to be enforced by the existing API authorization and SQL functions/triggers; this migration does not claim every table is row-isolated.
- If the app reports `permission denied` for a specific feature, stop and report the exact error rather than granting superuser or broad table access. The required privilege can then be added narrowly.
