# THRIFTFLIP

**A Student-to-Student Campus Marketplace for Used Textbooks, Goods, Bidding and Direct Swaps**
DBMS Level 3 project, Option 2: **SQL + Vector Database** (PostgreSQL + pgvector).

> **Honest status.** The database layer was run on a local PostgreSQL; `npm install`, the Vitest suite, the production build and the browser were not (see section 25).
> See [Status: VERIFIED / NOT VERIFIED](#status-verified--not-verified) and
> [Warnings](#warnings-read-first) before you run it. Expect to fix a few small errors on the first run.

---

## 1. Problem statement
Students own textbooks and campus goods they no longer need while other students need the same items. Ordinary marketplaces ignore
campus locality, course relevance, trust between students, fair prices, auction fraud (shill and last-second bidding), direct and
multi-way swaps, waitlists for reserved items, and discovery by meaning. THRIFTFLIP is a campus marketplace where the **database**
enforces integrity and implements the important business rules.

## 2. Objectives
1. Model a realistic marketplace in a normalized PostgreSQL schema (30 tables) with constraints at the database level.
2. Put business logic where the data is: transactions, row locks, functions, triggers and views.
3. Add semantic discovery with real embeddings stored in pgvector.
4. Provide a working Next.js application on top, with authentication and two roles.

## 3. Scope
**In scope:** student/admin accounts, listings (fixed price and auction), full-text and semantic search, bidding with anti-sniping,
suspicious-bidding detection, purchase state machine, direct and multi-way swaps, waitlist with claim windows, fair-price
estimation, demand analytics, recommendations, wishlist, price alerts, notifications, chat, ratings/reviews, reports and moderation, admin dashboard.
**Out of scope:** real payments (the "payment held" state is a record, not money movement), e-mail/SMS delivery, image upload, PESU SSO.

## 4. Functional requirements
| Area | Requirement |
|---|---|
| Accounts | B.Tech student registration (SRN, name, e-mail, department, semester, password; immediate access, no e-mail verification), login/logout, password reset, admin login, roles STUDENT and ADMIN |
| Profile | Update semester, department (first year only), profile photo, contact preferences |
| Listings | Sell a book with photos (title, author, edition, ISBN, condition, price, description), edit, delete (soft), **mark as sold**, browse, search and filter (title, author, ISBN, department, semester, course code, price, condition), favorites, recently viewed, buy fixed-price items, make offers |
| Auctions | Starting price, minimum increment, start/end time, bid history, highest bidder, bid validation, cancel a non-winning bid, closing and winner selection, anti-sniping |
| Fraud | Rule-based suspicious bidding classification NORMAL / SUSPICIOUS / HIGH_RISK, admin view |
| Transactions | PENDING → PAYMENT_HELD → HANDED_OFF → CONFIRMED → RELEASED (plus CANCELLED), history with actor |
| Swaps | Direct and multi-way swap detection (graph cycles), proposal, acceptance, conflict checks |
| Waitlist | Join, FIFO order, claim window (30 min), automatic expiry, notification of the next student |
| Prices | Fair price (30/25/25/20 weighting), historical min/avg/max, comparison with current listings, price alerts |
| Demand | HIGH / MEDIUM / LOW from wishlist, searches, bids, swap requests and supply, per book and per course |
| Search | PostgreSQL full-text search, semantic (vector) search, similar listings, recommendations |
| Social | Notifications, buyer-seller chat, ratings, reviews, reports and moderation |

## 5. Non-functional requirements
Integrity at the database level (CHECK/UNIQUE/FK/triggers); security (bcrypt, signed httpOnly cookie, parameterized SQL, Zod, role checks);
concurrency safety (row locks, unique indexes); performance (indexes, GIN, HNSW, pooling, pagination); simple readable code; reproducible setup (Docker, migrations, seed).

## 6. Tech stack
Next.js 14 (App Router, route handlers) · TypeScript · Tailwind CSS · PostgreSQL 16 · pgvector · `pg` (node-postgres) · Zod · bcryptjs · jose (JWT cookie) ·
`@xenova/transformers` (all-MiniLM-L6-v2) · Vitest · Docker Compose · tsx.

## 7. Database choice and justification
**Option 2: SQL + Vector database = PostgreSQL + pgvector.** pgvector is an *extension of PostgreSQL*, not another database.
No MongoDB, no NoSQL, no Qdrant/Pinecone/Chroma.

### Why PostgreSQL
The data is relational: students, campuses, departments, courses, books, listings, auctions, bids, transactions, swaps, waitlists, ratings,
reports, notifications. This needs primary and foreign keys, constraints, **ACID transactions**, **row-level locking** (`SELECT ... FOR UPDATE` so two
simultaneous bids or purchases cannot both win), joins and aggregation, **stored functions**, **triggers**, **views**, indexes and **full-text search**.

### Why pgvector
Textbook discovery is text-heavy (title, author, subject, course, edition, condition, description). A student who types
*"third year machine learning textbook"* should find "Pattern Recognition and Machine Learning" even though the phrase does not appear.
Embeddings capture meaning; pgvector stores them next to the relational data so one SQL query can combine similarity with filters
(`status = 'ACTIVE'`, campus) and joins, with no second system to keep in sync.

## 8. Architecture
```
Browser (Next.js pages, React, Tailwind)
        |  fetch JSON
Next.js Route Handlers  (app/api/**)  - auth check, Zod validation, parameterized SQL
        |  pg connection pool
PostgreSQL 16 + pgvector  - tables, constraints, views, functions, triggers, GIN + HNSW indexes
```
The API is thin on purpose: rules such as "bid must beat the current price", "valid state transitions", "anti-sniping" and "FIFO waitlist" live in SQL functions and triggers.


## 9. Relational schema and data dictionary
The full relational schema (table(columns), PK, FK) and the **data dictionary** (every column with type, constraints and description, plus all CHECK constraints) are in
[`docs/ER_AND_DATA_DICTIONARY.md`](docs/ER_AND_DATA_DICTIONARY.md). Regenerate with `npm run docs:generate` (needs Python 3).

## 10. Database tables (30)
| Group | Tables |
|---|---|
| Reference | `campus`, `department`, `course` (with semester), `college_email_domain` |
| Users | `student`, `admin`, `auth_token` (password reset) |
| Catalogue | `book`, `listing`, `listing_embedding` (pgvector), `image`, `listing_image`, `recently_viewed` |
| Selling | `auction`, `bid`, `offer`, `wishlist` |
| Swaps | `swap_preference`, `swap_request` |
| Deals | `transactions`, `transaction_state_history`, `waitlist` |
| Trust | `rating`, `review`, `report` |
| Communication | `conversation`, `message`, `notification` |
| Insight | `price_alert`, `search_activity` |

Names differ from the brief in two places: `transactions` (TRANSACTION is an SQL keyword) and column `item_condition` (CONDITION is a keyword). Plus a bookkeeping table `schema_migrations`.

## 11. Migrations (`db/migrations`)
| File | Content |
|---|---|
| `001_schema.sql` | `CREATE TABLE` with PRIMARY KEY, FOREIGN KEY, NOT NULL, UNIQUE, DEFAULT |
| `002_constraints.sql` | CHECK constraints with `ALTER TABLE ... ADD CONSTRAINT` |
| `003_indexes.sql` | B-tree, partial, unique and GIN indexes |
| `004_views.sql` | reputation, listing details, auction status, price history, **bid risk**, **demand**, waitlist queue, admin overview |
| `005_functions.sql` | `create_auth_token`, `verify_student_email`, `reset_student_password`, `mark_listing_sold`, `touch_recently_viewed`, `place_bid`, `close_auction`, `create_purchase`, `accept_offer`, `transition_transaction`, waitlist functions, `find_swap_cycles`, `propose_swap_cycle`, `respond_swap_request`, `calculate_fair_price`, `resolve_report` |
| `006_triggers.sql` | bid validation, transaction state machine and history, tsvector maintenance, price alerts, rating/offer/message/report rules |
| `007_pgvector.sql` | `listing_embedding vector(384)`, HNSW cosine index, `semantic_search`, `similar_listings`, `recommend_listings` |
| `008_reference_data.sql` | two campuses (RR Campus, EC Campus), the six B.Tech departments (CSE, CSE (AI & ML), Biotechnology, ECE, EEE, Mechanical) on each campus, college e-mail domain (no longer enforced) |
| `009_any_email.sql` | replaces `validate_student()` so any valid e-mail can register (college-domain check removed) |
| `010_direct_swaps.sql` | table `swap_proposal`, `transactions.swap_proposal_id`, notification types, `propose_swap`, `respond_swap_proposal`, `confirm_swap_exchange` |
| `011_reputation.sql` | new `v_student_reputation` (new accounts = 0, `completed_transactions`), stricter `validate_rating` (finished deals only) |
| `012_recommendations.sql` | `recommend_listings` rewritten: rule-based, works without embeddings |
| `013_offer_dedupe.sql` | one pending offer per buyer and listing (unique index) |
| `014_fixes.sql` | integer counts in `v_student_reputation` (the driver returned bigint as strings), `propose_swap` ownership order and missing-payer check, trigger that closes pending swap proposals when a book stops being available, recommendation reason labels |
| `015_book_cover_url.sql` | `book.cover_url` (link only, `IF NOT EXISTS`) and `v_listing_details.cover_url`; pages show uploaded photo, then cover link, then placeholder |
| `016_admin_reports_ratings_wanted.sql` | wanted books for swap listings, `v_student_ratings` (reputation score removed), review hiding, report workflow Pending → Under review → Resolved / Dismissed, `admin_action` log, `admin_message`, admin functions (`resolve_report` is dropped) |
| `017_wanted_books_and_cycle_swaps.sql` | wanted books shown from both `listing_wanted_book` and `swap_preference`; circular swaps (3+ students) need every participant to accept and then confirm (`confirm_swap_cycle`, `cancel_swap_cycle`); conflicting swaps are blocked |

Existing databases: run `npm run db:migrate`. It only adds the migration files that have not been applied yet (the newest is 021) and keeps your data. Applied files must never be edited. If it reports a checksum mismatch, do NOT run `db:reset`: back up with `pg_dump`, restore the original text of the named file, and migrate again.

## 12. Advanced database concepts (and where they are used)
| Concept | Implementation | Used by |
|---|---|---|
| **Transactions** | every SQL function runs atomically; `withTransaction` in the API | place bid, purchase, swaps, create listing + auction |
| **Row locking** | `SELECT ... FOR UPDATE` on the auction / listing / swap rows, `FOR UPDATE SKIP LOCKED` on the waitlist | concurrent bids, two buyers, claim windows |
| **Views** | `v_bid_risk`, `v_book_demand`, `v_course_demand`, `v_student_ratings`, `v_listing_details`, `v_auction_status`, `v_price_history`, `v_waitlist_queue`, `v_admin_overview` | admin dashboard, listing pages, analytics |
| **Stored functions** | see migration 005 | API calls them with parameterized `SELECT fn($1,...)` |
| **Triggers** | `validate_bid`, `tx_validate_transition`, `tx_after_change`, `listing_before_write`, `listing_price_alerts`, `validate_rating`, ... | rules hold even for direct SQL |
| **Indexes** | partial unique (one active transaction per listing, no equal valid bids), composite, GIN, HNSW | speed and integrity |
| **Full-text search** | `listing.search_vector` (tsvector, weights A/B/C) + GIN index, `websearch_to_tsquery`, `ts_rank` | marketplace search |
| **Vector similarity** | pgvector `<=>` cosine distance + HNSW index | semantic search, similar listings, recommendations |
| **Recursive CTE** | `find_swap_cycles` (graph cycles) | direct and multi-way swaps |
| **Window functions** | `LAG`, `ROW_NUMBER` | bid risk, waitlist position |

### Auction rules (in the database)
`place_bid()` locks the auction row; trigger `validate_bid` rejects: closed/not started/ended auctions, the seller, suspended bidders, bids below
the starting price (first bid) or below *current price + minimum increment*. **Anti-sniping:** a valid bid arriving in the last 60 seconds moves `end_time` forward by 2 minutes (`extension_count` counts it).
`close_auction()` selects the winner and opens an `AUCTION_WIN` transaction.

### Suspicious bidding (rule based, not machine learning)
`v_bid_risk` has one row per (bidder, seller). `risk_score = 3·rapid + 2·last_minute + 2·jump + 3·(auctions−1) + 5 if ≥15 bids`, where *rapid* = a bid within 30 s of the same bidder's previous bid in that auction,
*last_minute* = bid in the final 60 s, *jump* = increment ≥ 5× the minimum. **NORMAL** < 7 ≤ **SUSPICIOUS** < 15 ≤ **HIGH_RISK**. Cancelled bids are included so they cannot hide a pattern.

### Transaction state machine (purchases and auction wins)
`PENDING → PAYMENT_HELD → HANDED_OFF → CONFIRMED → RELEASED`, and `CANCELLED` from PENDING or PAYMENT_HELD. Trigger `trg_tx_validate_transition` rejects every other move (even a plain `UPDATE`);
trigger `trg_tx_after_change` writes `transaction_state_history` (previous state, new state, actor, time), updates the listing (SOLD/SWAPPED/ACTIVE) and notifies both parties.
The API decides *who* may ask (buyer: PAYMENT_HELD, CONFIRMED; seller: HANDED_OFF, RELEASED; admin: RELEASED; buyer/seller/admin: CANCELLED).

### Swaps
**Direct swaps (two students)** use table `swap_proposal` and three functions, all row-locking:
`propose_swap()` (the proposer offers one of THEIR OWN active fixed-price listings for a listing that is open to swaps; optional settlement amount + who pays; no self-swap, no unowned or unavailable book, no duplicate) →
`respond_swap_proposal()` (`accept` / `reject` by the receiver, `cancel` by the proposer while PENDING or by either student while ACCEPTED; accepting sets both listings to RESERVED and closes other pending proposals for them) →
`confirm_swap_exchange()` (after meeting, EACH student confirms; only when both did the proposal is COMPLETED, the listings become SWAPPED and exactly one `SWAP` transaction in state RELEASED is written, protected by a unique index; repeated calls change nothing).
Accepting alone never completes a swap. The settlement amount is only an agreement: THRIFTFLIP does not process payments. Completed swaps show up in both students' `/transactions`, count as one completed transaction each, and can be rated.
**Multi-way swaps (3 to 6 students)** are unchanged: preferences → `find_swap_cycles()` (recursive CTE) → `propose_swap_cycle()` → `respond_swap_request()`. They go through the normal transaction states and a cycle counts once for reputation only when every transaction of it is released. Known limitation: cancelling one transaction of a cycle does not cancel the others.

### Ratings and reviews (there is no reputation score)
A student is shown by their **average star rating (1 to 5), number of ratings and written reviews**, or "Not rated yet". Only finished deals (state RELEASED) can be rated, once per person per deal; `v_student_ratings` exposes `avg_rating`, `rating_count`, `completed_sales`, `completed_swaps`. An admin can hide a review's text (the stars still count); the author is told why.

### Waitlist
Only reserved fixed-price listings can be waited for. When the deal is cancelled the first waiting student (FIFO by `joined_at`, then id) is notified and gets a 30-minute claim window; the listing is held for them.
`expire_waitlist_claims()` expires unused claims and notifies the next student (the API calls it whenever waitlists or auctions are read).

### Fair price
Weighted average of four averages over finished sales (CONFIRMED/RELEASED, not swaps): **30 %** same title and author, **25 %** same edition (same book row), **25 %** same condition within the subject, **20 %** same course.
Components with no data are skipped and the weights re-scaled. The page also shows historical min/avg/max and the current listing range. No prices are hard-coded.

### Demand
`demand_score = 2·wishlists + searches/views (30 days) + bids + 2·swap requests`; `ratio = score / max(available listings, 1)`: **HIGH** ≥ 6, **MEDIUM** ≥ 2, otherwise **LOW**. Course demand sums its books.

## 13. Vector embedding process
| Question | Answer |
|---|---|
| What is embedded? | one text per listing: title, author, subject, course, edition, condition words and description (`lib/embeddings/listing-text.ts`) |
| Model | **all-MiniLM-L6-v2** (sentence-transformers), loaded in Node through its ONNX port `Xenova/all-MiniLM-L6-v2` with `@xenova/transformers`; mean pooling, normalized |
| Dimension | **384** |
| Storage | `listing_embedding.embedding vector(384)` in PostgreSQL, with the exact `source_text` and model name |
| Similarity | **cosine** (`<=>` is cosine *distance*; similarity = 1 − distance) |
| Index | **HNSW** with `vector_cosine_ops` |
| One model | the same function `embedText()` embeds listings and search queries |

Retrieval: `search text → embedText() → 384 numbers → SELECT * FROM semantic_search($1::vector, 20, campus)` →
`ORDER BY embedding <=> query LIMIT n` (uses the HNSW index) → joined with listing details. *Similar listings* use the listing's own stored vector; *recommendations* use the average vector of the student's wishlist plus course, recent-search and purchase-subject bonuses.
Embeddings are generated by `npm run embeddings:generate` (batch) and after each listing create/edit (best effort). The tests for the SQL side use synthetic 384-d vectors; a model test runs with `RUN_MODEL_TESTS=1`.

## 14. Important SQL queries
`db/queries/important_queries.sql` (run it after seeding). Highlights:
| # | Query | Demonstrates |
|---|---|---|
| A | scratch table CREATE / ALTER / DROP | DDL |
| B | INSERT / UPDATE / DELETE / SELECT | DML, CHECK violation |
| C1 | sellers with ≥ 2 active listings: COUNT/AVG/MIN/MAX/SUM | JOIN, GROUP BY, HAVING, ORDER BY, aggregates |
| C2 | highest bidder of each auction | subquery with MAX |
| C3–C5 | auction stats per campus, transaction stats, popular books | multi-table aggregation |
| D1–D3 | listings under the average sold price, students with no activity, filtered course search | correlated subquery, NOT EXISTS, complex filter |
| E1 | suspicious bidding | view, window functions |
| E2 | fair price for every listing | `LATERAL` + function |
| E3 | demand per book and course | views |
| E4 | swap matches | recursive CTE |
| E5–E6 | waitlist queue, transaction audit trail | views, trigger-written history |
| E7 | full-text search | tsvector, GIN, ts_rank |
| E8–E10 | semantic search, similar listings, `EXPLAIN` of the HNSW query | pgvector |
| F | invalid transition, anti-sniping, row locking (commented, run by hand) | triggers, transactions |

## 15. API structure (`app/api`, 51 route files)
| Area | Routes |
|---|---|
| Auth | `POST auth/register` (logs the student in at once), `POST auth/login` (student or admin), `POST auth/logout`, `POST auth/forgot`, `POST auth/reset`, `GET auth/me`, `GET reference?type=campuses\|departments&campusId=\|department-names\|courses` |
| Listings | `GET/POST listings` (filters: q, isbn, campusId, department (name), semester, courseCode, minPrice, maxPrice, condition, type, sort, page), `GET/PUT/DELETE listings/[id]`, `POST listings/[id]/sold`, `POST/DELETE listings/[id]/images`, `GET images/[id]`, `GET recently-viewed`, `GET books` |
| Search | `GET search` (full-text), `GET search/semantic`, `GET recommendations` |
| Auctions | `GET auctions`, `GET auctions/[id]`, `POST bids`, `DELETE bids/[id]` |
| Offers / buying | `GET/POST offers`, `POST offers/[id]` (accept, reject, withdraw), `GET/POST transactions`, `GET/POST transactions/[id]` (state change) |
| Wishlist | `GET/POST/DELETE wishlist` |
| Swaps | direct: `GET/POST swaps/proposals`, `POST swaps/proposals/[id]` (accept, reject, cancel, confirm) · multi-way: `GET/POST swaps`, `POST swaps/[id]`, `GET swaps/matches`, `POST/DELETE swaps/preferences` |
| Waitlist | `GET/POST waitlist`, `POST waitlist/[id]` (claim, leave) |
| Prices / demand | `GET price-intelligence`, `GET/POST/DELETE price-alerts`, `GET demand` |
| Social | `GET/POST notifications`, `GET/POST conversations`, `GET/POST conversations/[id]`, `POST ratings`, `GET/PUT profile`, `POST/DELETE profile/photo`, `GET profile/[id]`, `POST reports` |
| Health | `GET health` (development only: shows what is set up and what is missing) |
| Admin | `GET admin/overview`, `GET admin/suspicious`, `GET admin/reports`, `GET/POST admin/reports/[id]` (status with reason), `POST admin/actions` (warn, suspend, reactivate, remove/restore listing, hide/restore review), `POST admin/messages`, `GET admin/users`, `GET admin/listings`, `GET admin/reviews`, `POST admin/close-auctions` |
| Notices | `GET/POST notices` (a student reads and answers admin messages) |

Every handler: authenticates (`requireStudent` / `requireAdmin`), validates input with Zod, uses parameterized SQL, and maps PostgreSQL errors (`23514` → 400, `23505` → 409, `P0002` → 404) to clean JSON errors.

## 16. Pages
`/` landing · `/login` · `/register` · `/forgot-password` · `/reset-password` · `/dashboard` · `/marketplace` (browse, full-text, semantic) · `/listings/new` · `/listings/[id]` · `/listings/[id]/edit` · `/auctions` · `/auctions/[id]` (live bidding) · `/wishlist` · `/swaps` (direct proposals, matches, preferences) · `/waitlist` · `/transactions` · `/transactions/[id]` · `/notifications` · `/messages` · `/profile` · `/profile/[id]` (ratings and reviews) · `/recently-viewed` · `/recommendations` · `/price-intelligence` · `/notices` (messages from admins) · `/admin` · `/admin/reports` · `/admin/users` · `/admin/listings` (listings and reviews) · `/admin/analytics`.

## 17. Authentication and authorization
**Registration form:** SRN (placeholder `PES1UG24AM411`), name, **e-mail**, course (fixed **B.Tech**, `CHECK program = 'B.Tech'`), **campus**, then **department** (the list stays disabled with "Select campus first..." until a campus is chosen, then shows that campus's six departments: CSE, CSE (AI & ML), Biotechnology, ECE, EEE, Mechanical), semester 1 to 8 and an **independent THRIFTFLIP password**. The student's campus is stored from the chosen department by a trigger. **PESU Academy passwords are never requested or stored.**
**E-mail rule:** any valid e-mail address (Gmail, Outlook, college...) can register, and **e-mail verification does not exist any more**: registration logs the student in and the marketplace is open at once (no link, no SMTP needed). The format is checked by Zod and a CHECK constraint, and the address is unique (case-insensitive). To restrict registration to a college, set `COLLEGE_EMAIL_DOMAINS=pes.edu,pesu.pes.edu` (comma separated, sub-domains accepted) in `.env.local`; empty = anybody. The rule lives in `lib/auth/emailPolicy.ts` and is applied in `POST /api/auth/register`. Old columns `student.email_verified*` and the table `college_email_domain` stay in the database for compatibility but are not used.
**Password reset:** `/forgot-password` e-mails a one-hour, single-use link (the page never reveals whether an e-mail is registered); `/reset-password` sets the new bcrypt hash and invalidates every other token.
**E-mail delivery (password reset only):** configure `SMTP_*` in `.env.local`. Without `SMTP_HOST` nothing is sent and the reset link is printed in the terminal running `npm run dev`.
**Passwords** are hashed with bcrypt (cost 10). Login sets a signed (HS256) **httpOnly, SameSite=Lax** cookie valid 7 days; logout clears it.
**Roles:** `STUDENT` and `ADMIN` (separate `admin` table). Middleware redirects visitors from protected pages and non-admins from `/admin`; **every API route re-checks** the session, role and the student's status (suspended students are locked out).
**Profile management (`/profile`):** semester (can only increase), department (only in semesters 1 and 2: first-year branch change), profile photo, contact preference (in-app, e-mail, phone) and whether buyers may see it. These rules are enforced by the trigger `validate_student`, not only by the form.
**Photos:** stored in PostgreSQL (`image` table, BYTEA), JPEG/PNG/WebP only (checked from the file's first bytes), 2 MB each, 5 per listing (trigger), one profile photo per student (unique index).

## 18. Security
1. **Registration** is immediate; the only e-mail rule is the optional `COLLEGE_EMAIL_DOMAINS` list (see section 18).
2. **Password reset** needs e-mail. Without `SMTP_HOST` (development) the reset link is printed in the terminal and returned to the page; this switches itself off in production.
3. **Real e-mails** (only for password reset): fill in `.env.local` and restart `npm run dev`:
   ```
   APP_URL=http://localhost:3000
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your.address@gmail.com
   SMTP_PASS=<a Google "App password", not your normal password>
   MAIL_FROM=THRIFTFLIP <your.address@gmail.com>
   ```
4. **Still enforced:** bcrypt password hashing, signed httpOnly session cookie, role and suspended-account checks on every API route.

## 19. Setup and run
Requirements: Node.js 20+, npm, Docker Desktop (for PostgreSQL + pgvector), internet for `npm install` and for the first embedding run (model download, about 90 MB).
```bash
cd thriftflip
npm install
cp .env.example .env.local
cp .env.example .env          # docker compose reads .env
# edit BOTH files: set POSTGRES_PASSWORD (and the same password inside DATABASE_URL / TEST_DATABASE_URL) and SESSION_SECRET
# optional: SMTP_* to really send e-mails (otherwise links are printed in the terminal)
docker compose up -d
npm run db:migrate
npm run db:seed
npm run embeddings:generate   # first run downloads the model
npm run dev
```
Open **http://localhost:3000**.
A newly registered account can use the marketplace immediately (no verification link).
Demo logins (local only): `aarav.sharma@thriftflip.test` / `Demo@12345` (any seeded student: `<firstname>.<lastname>@thriftflip.test`), admin `admin@thriftflip.test` / `Admin@12345`.

**Database role-based access control (RBAC):** see [`DB_RBAC_SETUP.md`](DB_RBAC_SETUP.md). Migration `022_database_rbac.sql` adds separate non-superuser student/admin/auth roles and row-level policies for student-owned records. Keep `DATABASE_URL` for migrations; after completing the setup guide, use `APP_DATABASE_URL` for the Next.js app.

**Creating an admin** (the only way; students can never become admins): `npm run admin:create -- "Full Name" admin@example.com "a-strong-password"`. Running it again for the same e-mail resets that admin's name and password. Admins have only a name, e-mail and password, and all admins have the same full permissions.

| Task | Command |
|---|---|
| Stop the database | `docker compose down` |
| Stop and delete all data | Destructive: removes the database volume. Do not use on a database containing data you want to keep. |
| Re-create tables only | `npm run db:reset -- --confirm=<database name>` (**deletes all data**; refuses to run without `--confirm`), then `npm run db:seed` |
| Re-seed | `npm run db:seed -- --force --confirm=<database name>` (wipes data first; without `--force` a second run does nothing, so no duplicates, and the seed refuses to run on a database that already holds students or listings) |
| Check the set-up | `npm run doctor` (finds missing env values, database not running, outdated tables, missing departments or college domain) and http://localhost:3000/api/health |
| Tests | `npm test` (uses `TEST_DATABASE_URL`) |
| Model test too | `RUN_MODEL_TESTS=1 npm test` |
| Type check | `npm run typecheck` |
| Production build | `npm run build` then `npm start` |
| Regenerate ER + dictionary | `npm run docs:generate` |

## 20. Testing
`npm test` (Vitest, real PostgreSQL): registration, login, sessions and authorization rules · database constraints · bidding rules, invalid bids, anti-sniping, concurrent bids, auction closing ·
suspicious-bidding classification · transaction state machine, invalid transitions, history, concurrent purchases · waitlist FIFO, claim window, expiry · direct swap proposals (workflow, guards, concurrency, no double completion), three-way swaps · reputation formula and rating eligibility · marketplace filters · recommendation fallbacks ·
password reset tokens, e-mail policy, profile rules (semester, department, contact), photos (limits, types), book filters and ISBN search, mark as sold, recently viewed · fair price (exact weighted numbers), demand levels, full-text search, price alerts, reputation, moderation · pgvector storage, cosine ordering, filters, similar listings, recommendations, HNSW index.
The tests create `thriftflip_test` automatically and **delete all data in it**. If `TEST_DATABASE_URL` is missing, `npm test` uses `thriftflip_test` on the same server as `DATABASE_URL`. Safeguards (`tests/testEnv.ts`): the database name must end in `_test`, it must not be the same database as `DATABASE_URL`, the server must be local (override only with `ALLOW_REMOTE_TEST_DB=1`), and before every wipe the test code asks PostgreSQL for `current_database()`. Test config is `vitest.config.mts` (ES module, avoids Vite's CJS deprecation warning).

## 21. Demo instructions (viva)
1. **Schema:** show `docs/ER_AND_DATA_DICTIONARY.md`; run `\dt`, `\dv`, `\df` in `psql` (`docker exec -it thriftflip-db psql -U thriftflip`).
2. **DDL/DML/queries:** run `db/queries/important_queries.sql` section by section.
3. **Search:** marketplace → *Full-text* "machine learning"; then *Semantic* "third year machine learning textbook" (vector similarity, similarity percentages).
4. **Auction + anti-sniping:** `/auctions` → open the auction ending in about 1 hour; place bids; invalid bid shows the database message. Anti-sniping: `SELECT * FROM place_bid(<auction>, <student>, <amount>, <end_time - interval '30 seconds'>);` and show `end_time` moved by 2 minutes (or see the test).
5. **Fraud:** log in as admin → `/admin` → suspicious bidding table (Rohan HIGH_RISK, Ishaan SUSPICIOUS) → `SELECT * FROM v_bid_risk;`.
6. **State machine:** `/transactions` → open a deal → move forward; try an invalid jump in SQL: `UPDATE transactions SET state='RELEASED' WHERE state='PENDING';` → rejected by trigger; show history.
7. **Swaps:** log in as Tanvi, Sneha or Meera (3-way) or Diya/Arjun (direct) → `/swaps` → propose, then answer as the other students.
8. **Waitlist:** log in as Aarav, cancel the Raspberry Pi deal; Diya (first in line) is notified. Priya already holds a live claim on the calculator.
9. **Prices and demand:** `/price-intelligence`, `/admin/analytics`.
10. **Locking:** two `psql` sessions with `BEGIN; SELECT ... FOR UPDATE;` (see section F of the query file).

## 22. Git / GitHub
```bash
git init
git add .
git status                      # check that .env, .env.local and node_modules are NOT listed
git commit -m "THRIFTFLIP: schema, API, UI, tests"
git branch -M main
git remote add origin https://github.com/<your-user>/thriftflip.git
git push -u origin main
```
`.gitignore` excludes `node_modules`, `.next`, `.env`, `.env.local`, logs and zip files. Never commit passwords, database credentials or `SESSION_SECRET`. Team of 2: use one branch per feature and pull requests.

## 23. Project structure
```
thriftflip/
├── app/                 pages (login, register, dashboard, marketplace, listings, auctions, swaps, ...) and app/api route handlers
├── components/          Nav, shared UI
├── lib/                 db/ (pool, migration runner), auth/ (service, tokens, session), validation/ (Zod), embeddings/, email.ts, images.ts, http.ts, sql.ts, transactions.ts
├── db/migrations/       001..008 SQL files
├── db/queries/          important_queries.sql (viva)
├── scripts/             migrate.ts, seed.ts, generate_embeddings.ts, gen_docs.py
├── tests/               Vitest suites + helpers
├── docs/                ER_AND_DATA_DICTIONARY.md
├── docker-compose.yml, package.json, .env.example, .gitignore, README.md
```

## 24. Status: VERIFIED / NOT VERIFIED
**VERIFIED (executed in the last rounds, PostgreSQL 16 without pgvector, a stand-in `vector` type was used only for this check):**
- Migrations 001-006 and 008-013 apply cleanly in order on an empty database.
- Direct swap workflow in SQL: self-swap, unowned book, non-swappable listing, duplicate, unavailable listing, wrong actor, accept before/after, listings RESERVED then SWAPPED, one confirmation is not enough, repeated and concurrent confirmations create exactly ONE transaction, a completed proposal cannot be cancelled, two overlapping proposals cannot both be accepted (second is cancelled under the row lock).
- Ratings: a new student is "Not rated yet"; only finished deals can be rated; self-rating, outsider rating and duplicate rating are refused.
- Marketplace filter SQL (generated by `lib/listingFilters.ts`): partial title / author / ISBN (also with hyphens), type sale / auction / swap, availability, price range, condition, semester, department, course code, campus, pagination, invalid input rejected.
- `recommend_listings`: returns department/semester matches, falls back to recent listings, excludes own and unavailable listings.
- Migration 014 on both a fresh database (001-014 in order) and a database already migrated to 013; the SQL scenarios behind the 11 formerly failing tests (integer counts, `WARNED` moderation action, swap ownership and payer checks, stale-proposal closing, recommendation reasons).
- TypeScript syntax and name resolution of every file (global `tsc`, errors caused only by the missing `node_modules` ignored).

**NOT VERIFIED (npm registry unreachable in that environment):**
- `npm install`, `npm test` (Vitest), `npm run typecheck` with real type packages, `npm run lint`, `npm run build`, `npm run dev`.
- The new and changed Vitest files (`swapProposals`, `ratings`, `recommendations`, `marketplaceFilters`, `emailPolicy`, `auth`, `student`, `email`) were written against the SQL above but have not been run.
- pgvector (`007`, vector similarity bonus), `db:seed`, `embeddings:generate`, and every browser behaviour.

## 25. Warnings (read first)
1. **Nothing has been run.** Expect small errors (a typo in SQL, a type error). Run in this order and fix the first error before continuing: `npm install` → `docker compose up -d` → `npm run db:migrate` → `npm run db:seed` → `npm run doctor` → `npm run typecheck` → `npm test` → `npm run build`. Paste an error into Cursor/Claude and it can be fixed quickly.
2. `next.config.mjs` sets `typescript.ignoreBuildErrors: true` so a stray type error does not block the first build. Run `npm run typecheck`, fix what it prints, then set it to `false`.
3. **Two env files:** `docker compose` reads `.env`; Next.js and the scripts read `.env.local`. Fill both (copy the same file). Docker refuses to start without `POSTGRES_PASSWORD`.
4. **`npm test` deletes all data** in `TEST_DATABASE_URL` (default database `thriftflip_test`). Never point it at your real database; `npm run db:reset` and `db:seed -- --force` also delete data (both now refuse to run unless you repeat the database name with `--confirm=<name>`). Never run them against a database you want to keep.
5. **Demo passwords** (`Demo@12345`, `Admin@12345`) are for local use only. Change them with `SEED_DEMO_PASSWORD` / `SEED_ADMIN_PASSWORD` or do not seed in any shared environment.
6. **First embedding run downloads about 90 MB** from Hugging Face (needs internet). Until embeddings exist, semantic search and "similar listings" return nothing and recommendations fall back to course matches.
7. `onnxruntime-node` (used for embeddings) is a native package; if `npm install` fails on your machine use Node 20 LTS and install your OS build tools. Password hashing uses pure-JavaScript `bcryptjs`, so it needs no compiling.
8. Port 5432 or 3000 already in use: change `POSTGRES_PORT` (and the URLs) or run `npm run dev -- -p 3001`.
9. Docker image `pgvector/pgvector:pg16` is required (plain `postgres` has no `vector` extension). `AVG(vector)` needs pgvector 0.5 or newer (included).
10. Seeded auction `LIVE` times are relative to the moment you seed: re-seed with `--force` before a demo so the 1-hour auction is still open.
11. Payments are simulated; ISBNs in the seed data are illustrative; do not enter your PESU Academy password anywhere.
12. If you ran an earlier version of this project, `npm run db:migrate` will refuse to continue ("older version of the SQL files"). Back it up with `pg_dump` first. Only if it holds demo data and nothing else, rebuild it with `npm run db:reset -- --confirm=<database name>` then `npm run db:seed`.
13. Known limitation: if one transaction of a multi-way swap is cancelled, the other transactions of that swap are not cancelled automatically.

## 26. Registration and e-mail (no verification)
1. Students register and use the marketplace immediately. No e-mail is sent at registration.
2. Optional college restriction: `COLLEGE_EMAIL_DOMAINS=your-college.edu` in `.env.local`, then restart `npm run dev`.
3. Existing accounts that were "unverified" are not blocked any more (the check was removed from `requireStudent`); no data migration is needed.
4. `npm run college:domain` edits the old `college_email_domain` table, which is no longer read. Use the environment variable instead.

## 27. Troubleshooting
| Symptom | Cause and fix |
|---|---|
| Register page shows "Internal server error" and the Department list is empty | The database is not running, not migrated, or built from older SQL. Run `npm run doctor`; the page now also prints the exact reason. Usual fix: `docker compose up -d`, then `npm run db:migrate` (keeps your data), then restart `npm run dev`. Use `npm run db:reset` only on a throw-away demo database. |
| "DATABASE_URL is not set" | Create `.env.local` (`cp .env.example .env.local`), fill it in, **restart** `npm run dev` (env files are read at start). |
| "The database rejected the login" | The password in `DATABASE_URL` differs from `POSTGRES_PASSWORD` in `.env`. Make them equal. If you changed it after the first `docker compose up`, update the PostgreSQL role password safely in `psql`; do not delete the database volume. |
| `npm run db:migrate` says "older version of the SQL files" | The database was created by an earlier version. Back it up with `pg_dump` first. Only a throw-away demo database may be rebuilt: `npm run db:reset -- --confirm=<database name>` then `npm run db:seed` (deletes all data). |
| Department dropdown says "Could not load departments" | Same as the first row; press "Try again" after fixing. |
| Register shows "Internal server error" and the page still has a *Campus* field | You are running an older or edited copy of the project (the current register page has no Campus field). Use a clean copy: see "Clean restart" below. |
| Department list says "Select campus first..." | Normal: choose the campus first. If the campus list is empty, the database has no campuses: `npm run doctor`. |
| Page looks dark or unreadable | A dark-mode browser extension is altering colours. The app declares a light theme; disable the extension for localhost. |
| `Cannot find module 'nodemailer'` (or another package) | `npm install` was not re-run after an update. |

### Clean restart (fixes mixed old/new copies and old databases)
```bash
# 1. Make a separate copy of the source folder; do not delete or reset the existing database volume.
# 2. Keep the existing .env / .env.local values and DATABASE_URL pointed at the current database.
# 3. Install dependencies in the copied source folder, then run migrations (additive migrations preserve data).
npm install
npm run db:migrate
npm run doctor        # every line must say OK
npm run dev           # restart it after every change of .env.local
```
If an error remains, copy the **first red line** printed after `POST /api/auth/register 500` in the `npm run dev` terminal (the message, not the long list of `at ...` lines).

## 28. Release 1 notes: account verification and marketplace

- **E-mail domain.** Any valid e-mail can register (migration 009); an optional `COLLEGE_EMAIL_DOMAINS` environment variable restricts it. There is no e-mail verification.
- **The course catalogue is demo data.** The 12 courses (code, name, semester) are inserted by `npm run db:seed`. Without the seed there are no course codes to pick; add real courses with SQL (`INSERT INTO course (department_id, code, name, semester) ...`) until an admin screen exists.
- **Campuses:** `RR Campus` and `EC Campus` (names taken from your screenshot) are inserted by migration 008; edit that file for other names. The demo course catalogue is attached to the RR campus departments.
- **Department change rule** (semesters 1 and 2 only) and **semester only upward** are my interpretation of "update where appropriate".
- **Search by department / semester / course code** works through the book's course. A book listed without a course code still appears in search by title, author and ISBN, but not in department/semester filters.
- **Images live in PostgreSQL**, which is simple and backed up with the data, but large. For many users move them to file or object storage. Any logged-in user who knows an image id can view it.
- **Schema changed in place.** If you ran an earlier version, back it up with `pg_dump` and use `npm run db:migrate`. Only a throw-away demo database may be rebuilt with `npm run db:reset -- --confirm=<database name>` and `npm run db:seed` (this deletes all data).
- Not built: e-mail change, "remember me", admin screens for courses and e-mail domains, rate limiting of password-reset e-mails.

## 29. Future enhancements
Real payment gateway/escrow · e-mail and push notifications · scheduled jobs (pg_cron) for auction closing and waitlist expiry · image upload · rate limiting ·
CSRF tokens · hybrid ranking (full-text + vector) · bid-risk thresholds tuned from data (or a learned model) · WebSocket live bidding · SSO with the university if officially offered · Row-level security policies.

## User interface (cream and dark brown design)

Brand colours: cream `#F2E6B3` (page) and dark brown `#4B2E21` (text, buttons, navigation). They are defined once in `tailwind.config.ts` (the `gray` and `indigo` scales are mapped to warm browns, so older `text-gray-*` classes follow the palette) and in `app/globals.css` (`.btn`, `.card`, `.input`, tables).

Shared building blocks (interface only, no business logic):

| File | What it gives you |
|---|---|
| `components/ui.tsx` | `PageTitle`, `SectionTitle`, `Tip` (hover/focus tooltip), `Help` (the small "?"), `Hint` (dismissible instructions), `Alert`, `Empty`, `Badge`, `StatCard`, `Stepper`, `ListingCard` |
| `components/feedback.tsx` | `useConfirm()` confirmation dialog and `useToast()` messages (provider is in `app/layout.tsx`) |
| `components/icons.tsx` | small inline SVG icon set |
| `components/Nav.tsx` | responsive navigation (menu button on tablet/phone, "More" menu on desktop) |
| `lib/ui-text.ts` | tooltip wording for deal states |

Hovering (or tabbing to) a button, badge, card or "?" explains what it does. Irreversible actions (buying, bidding, accepting a swap, cancelling a deal, deleting, admin actions) ask for confirmation first.

## Book cover images
Order: student photo → `book.cover_url` (Open Library) → demo cover in `public/covers/<isbn>.svg` (no migration needed) → title placeholder. The bundled SVGs are original demo artwork, not publisher covers.
