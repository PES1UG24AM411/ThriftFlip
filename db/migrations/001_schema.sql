-- 001_schema.sql
-- Tables with PRIMARY KEY, FOREIGN KEY, NOT NULL, UNIQUE and DEFAULT.
-- CHECK constraints are added afterwards (ALTER TABLE) in 002_constraints.sql.
-- The listing_embedding table (pgvector) is created in 007_pgvector.sql.
--
-- FORMAT RULE (scripts/gen_docs.py parses this file to build the ER diagram
-- and data dictionary): one column per line, ending with "-- description".

-- ---------- Reference data: campus -> department -> course ----------

CREATE TABLE campus (
    campus_id SERIAL PRIMARY KEY, -- surrogate key of the campus
    name TEXT NOT NULL UNIQUE, -- campus name
    city TEXT NOT NULL -- city where the campus is located
);

CREATE TABLE department (
    department_id SERIAL PRIMARY KEY, -- surrogate key of the department
    campus_id INTEGER NOT NULL REFERENCES campus(campus_id), -- campus the department belongs to
    name TEXT NOT NULL, -- department name
    UNIQUE (campus_id, name)
);

CREATE TABLE course (
    course_id SERIAL PRIMARY KEY, -- surrogate key of the course
    department_id INTEGER NOT NULL REFERENCES department(department_id), -- department offering the course
    code TEXT NOT NULL, -- course code, e.g. UE23CS201
    name TEXT NOT NULL, -- course title
    semester INTEGER NOT NULL, -- semester in which the course is taught (1 to 8)
    UNIQUE (department_id, code)
);

-- ---------- Users ----------

CREATE TABLE college_email_domain (
    domain TEXT PRIMARY KEY -- allowed college e-mail domain (sub-domains are accepted too), lower case
);

CREATE TABLE student (
    student_id SERIAL PRIMARY KEY, -- surrogate key of the student
    srn TEXT NOT NULL UNIQUE, -- university student ID (SRN), upper-case letters and digits
    name TEXT NOT NULL, -- full name
    email TEXT NOT NULL UNIQUE, -- college e-mail, stored in lower case (domain checked by trigger)
    password_hash TEXT NOT NULL, -- bcrypt hash of the independent THRIFTFLIP password
    campus_id INTEGER NOT NULL REFERENCES campus(campus_id), -- campus of the department (filled by trigger)
    department_id INTEGER NOT NULL REFERENCES department(department_id), -- B.Tech department
    program TEXT NOT NULL DEFAULT 'B.Tech', -- degree programme (only B.Tech for now)
    semester INTEGER NOT NULL, -- current semester (1 to 8)
    email_verified BOOLEAN NOT NULL DEFAULT false, -- true after the e-mail link was used
    email_verified_at TIMESTAMPTZ, -- time of verification
    contact_preference TEXT NOT NULL DEFAULT 'IN_APP', -- IN_APP, EMAIL or PHONE
    phone TEXT, -- optional phone number
    show_contact BOOLEAN NOT NULL DEFAULT false, -- show the preferred contact method to buyers
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE or SUSPENDED
    warning_count INTEGER NOT NULL DEFAULT 0, -- number of moderation warnings
    created_at TIMESTAMPTZ NOT NULL DEFAULT now() -- registration time
);

CREATE TABLE auth_token (
    token_hash TEXT PRIMARY KEY, -- SHA-256 of the secret token sent by e-mail (the token itself is never stored)
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- student the token belongs to
    purpose TEXT NOT NULL, -- VERIFY_EMAIL or RESET_PASSWORD
    expires_at TIMESTAMPTZ NOT NULL, -- token is invalid after this time
    used_at TIMESTAMPTZ, -- set when the token was used (single use)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now() -- creation time
);

CREATE TABLE image (
    image_id SERIAL PRIMARY KEY, -- surrogate key of the image
    owner_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- student who uploaded it
    purpose TEXT NOT NULL, -- PROFILE or LISTING
    content_type TEXT NOT NULL, -- image/jpeg, image/png or image/webp
    size_bytes INTEGER NOT NULL, -- file size in bytes (max 2 MB)
    data BYTEA NOT NULL, -- the image file itself
    created_at TIMESTAMPTZ NOT NULL DEFAULT now() -- upload time
);

CREATE TABLE admin (
    admin_id SERIAL PRIMARY KEY, -- surrogate key of the administrator
    name TEXT NOT NULL, -- full name
    email TEXT NOT NULL UNIQUE, -- login e-mail, stored in lower case
    password_hash TEXT NOT NULL, -- bcrypt hash of the admin password
    created_at TIMESTAMPTZ NOT NULL DEFAULT now() -- creation time
);

-- ---------- Catalogue and listings ----------

CREATE TABLE book (
    book_id SERIAL PRIMARY KEY, -- surrogate key of the book edition
    isbn TEXT UNIQUE, -- ISBN-10 or ISBN-13 without hyphens (optional)
    title TEXT NOT NULL, -- book title
    author TEXT NOT NULL, -- author name(s)
    edition INTEGER NOT NULL DEFAULT 1, -- edition number
    subject TEXT NOT NULL, -- subject area, e.g. Machine Learning
    course_id INTEGER REFERENCES course(course_id) -- course that recommends the book (optional)
);

CREATE TABLE listing (
    listing_id SERIAL PRIMARY KEY, -- surrogate key of the listing
    seller_id INTEGER NOT NULL REFERENCES student(student_id), -- student who owns the item
    book_id INTEGER REFERENCES book(book_id), -- book edition (required for textbooks, NULL for goods)
    campus_id INTEGER NOT NULL REFERENCES campus(campus_id), -- campus where the item is available
    category TEXT NOT NULL DEFAULT 'TEXTBOOK', -- TEXTBOOK or GOODS
    title TEXT NOT NULL, -- listing title
    description TEXT NOT NULL DEFAULT '', -- free-text description
    item_condition TEXT NOT NULL, -- NEW, LIKE_NEW, GOOD, FAIR or POOR
    listing_type TEXT NOT NULL DEFAULT 'FIXED_PRICE', -- FIXED_PRICE or AUCTION
    price NUMERIC(10,2) NOT NULL, -- asking price (starting price for auctions)
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, RESERVED, SOLD, SWAPPED or REMOVED
    open_to_swap BOOLEAN NOT NULL DEFAULT false, -- seller accepts swaps for this item
    search_vector TSVECTOR, -- full-text search document, maintained by trigger
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- creation time
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- last modification time
);

CREATE TABLE listing_image (
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- listing the photo belongs to
    image_id INTEGER NOT NULL REFERENCES image(image_id) ON DELETE CASCADE, -- the photo
    position INTEGER NOT NULL DEFAULT 0, -- display order (0 is the cover photo)
    PRIMARY KEY (listing_id, image_id)
);

CREATE TABLE recently_viewed (
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- student who looked at the listing
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- listing that was viewed
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- last time it was viewed
    PRIMARY KEY (student_id, listing_id)
);

-- ---------- Auctions and bids ----------

CREATE TABLE auction (
    auction_id SERIAL PRIMARY KEY, -- surrogate key of the auction
    listing_id INTEGER NOT NULL UNIQUE REFERENCES listing(listing_id) ON DELETE CASCADE, -- one auction per listing
    starting_price NUMERIC(10,2) NOT NULL, -- minimum first bid
    min_increment NUMERIC(10,2) NOT NULL DEFAULT 10, -- minimum raise over the current price
    start_time TIMESTAMPTZ NOT NULL, -- bidding opens
    end_time TIMESTAMPTZ NOT NULL, -- bidding closes (moved forward by anti-sniping)
    original_end_time TIMESTAMPTZ NOT NULL, -- end time before any extension
    current_price NUMERIC(10,2) NOT NULL, -- current highest bid (starting price when no bids)
    highest_bidder_id INTEGER REFERENCES student(student_id), -- current highest bidder
    winner_id INTEGER REFERENCES student(student_id), -- winner, set when the auction closes
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, CLOSED or CANCELLED
    extension_count INTEGER NOT NULL DEFAULT 0, -- how many times anti-sniping extended the deadline
    closed_at TIMESTAMPTZ -- time the auction was closed
);

CREATE TABLE bid (
    bid_id SERIAL PRIMARY KEY, -- surrogate key of the bid
    auction_id INTEGER NOT NULL REFERENCES auction(auction_id), -- auction being bid on
    bidder_id INTEGER NOT NULL REFERENCES student(student_id), -- student placing the bid
    amount NUMERIC(10,2) NOT NULL, -- bid amount
    placed_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the bid was placed
    seconds_before_end NUMERIC(10,2), -- seconds left in the auction when the bid arrived (set by trigger)
    status TEXT NOT NULL DEFAULT 'VALID' -- VALID or CANCELLED
);

CREATE TABLE offer (
    offer_id SERIAL PRIMARY KEY, -- surrogate key of the offer
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- fixed-price listing the offer is for
    buyer_id INTEGER NOT NULL REFERENCES student(student_id), -- student making the offer
    amount NUMERIC(10,2) NOT NULL, -- offered price
    message TEXT, -- optional note to the seller
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, ACCEPTED, REJECTED or WITHDRAWN
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the offer was made
    responded_at TIMESTAMPTZ -- time the seller or buyer responded
);

-- ---------- Wishlist and swaps ----------

CREATE TABLE wishlist (
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- student who saved the listing
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- saved listing
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time it was saved
    PRIMARY KEY (student_id, listing_id)
);

CREATE TABLE swap_preference (
    preference_id SERIAL PRIMARY KEY, -- surrogate key of the preference
    student_id INTEGER NOT NULL REFERENCES student(student_id), -- student expressing the preference (owner of the offered listing)
    offered_listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- item the student is willing to give away
    wanted_book_id INTEGER NOT NULL REFERENCES book(book_id), -- book the student wants in return
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the preference was added
    UNIQUE (offered_listing_id, wanted_book_id)
);

CREATE TABLE swap_request (
    swap_request_id SERIAL PRIMARY KEY, -- surrogate key of the swap request
    cycle_id UUID NOT NULL, -- all requests of one direct or multi-way swap share a cycle_id
    requester_id INTEGER NOT NULL REFERENCES student(student_id), -- student who wants the requested listing
    offered_listing_id INTEGER NOT NULL REFERENCES listing(listing_id), -- requester's own listing taking part in the swap
    requested_listing_id INTEGER NOT NULL REFERENCES listing(listing_id), -- listing the requester will receive
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, ACCEPTED, REJECTED or CANCELLED
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the request was created
    responded_at TIMESTAMPTZ -- time the owner of the requested listing answered
);

-- ---------- Transactions ----------

CREATE TABLE transactions (
    transaction_id SERIAL PRIMARY KEY, -- surrogate key of the transaction
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id), -- item being handed over
    buyer_id INTEGER NOT NULL REFERENCES student(student_id), -- student receiving the item
    seller_id INTEGER NOT NULL REFERENCES student(student_id), -- student giving the item
    amount NUMERIC(10,2) NOT NULL, -- agreed price (0 for swaps)
    transaction_type TEXT NOT NULL DEFAULT 'PURCHASE', -- PURCHASE, AUCTION_WIN or SWAP
    swap_request_id INTEGER REFERENCES swap_request(swap_request_id), -- swap request that produced this transaction
    state TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, PAYMENT_HELD, HANDED_OFF, CONFIRMED, RELEASED or CANCELLED
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- creation time
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- last state change
);

CREATE TABLE transaction_state_history (
    history_id SERIAL PRIMARY KEY, -- surrogate key of the history row
    transaction_id INTEGER NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE, -- transaction that changed
    previous_state TEXT, -- state before the change (NULL for the first row)
    new_state TEXT NOT NULL, -- state after the change
    changed_by_type TEXT NOT NULL DEFAULT 'SYSTEM', -- STUDENT, ADMIN or SYSTEM
    changed_by_id INTEGER, -- id of the acting student or admin (NULL for SYSTEM)
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now() -- time of the change
);

-- ---------- Waitlist ----------

CREATE TABLE waitlist (
    waitlist_id SERIAL PRIMARY KEY, -- surrogate key of the waitlist entry
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- listing being waited for
    student_id INTEGER NOT NULL REFERENCES student(student_id), -- student waiting
    status TEXT NOT NULL DEFAULT 'WAITING', -- WAITING, NOTIFIED, CLAIMED, EXPIRED or CANCELLED
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the student joined (FIFO order)
    notified_at TIMESTAMPTZ, -- time the student was told the item is available
    claim_expires_at TIMESTAMPTZ, -- end of the claim window
    UNIQUE (listing_id, student_id)
);

-- ---------- Reputation ----------

CREATE TABLE rating (
    rating_id SERIAL PRIMARY KEY, -- surrogate key of the rating
    transaction_id INTEGER NOT NULL REFERENCES transactions(transaction_id), -- transaction being rated
    rater_id INTEGER NOT NULL REFERENCES student(student_id), -- student giving the rating
    ratee_id INTEGER NOT NULL REFERENCES student(student_id), -- student being rated
    score INTEGER NOT NULL, -- 1 (worst) to 5 (best)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time of the rating
    UNIQUE (transaction_id, rater_id)
);

CREATE TABLE review (
    review_id SERIAL PRIMARY KEY, -- surrogate key of the review
    rating_id INTEGER NOT NULL UNIQUE REFERENCES rating(rating_id) ON DELETE CASCADE, -- rating the review belongs to
    body TEXT NOT NULL, -- review text
    created_at TIMESTAMPTZ NOT NULL DEFAULT now() -- time of the review
);

-- ---------- Chat ----------

CREATE TABLE conversation (
    conversation_id SERIAL PRIMARY KEY, -- surrogate key of the conversation
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- listing being discussed
    buyer_id INTEGER NOT NULL REFERENCES student(student_id), -- interested student
    seller_id INTEGER NOT NULL REFERENCES student(student_id), -- owner of the listing
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the conversation started
    UNIQUE (listing_id, buyer_id)
);

CREATE TABLE message (
    message_id SERIAL PRIMARY KEY, -- surrogate key of the message
    conversation_id INTEGER NOT NULL REFERENCES conversation(conversation_id) ON DELETE CASCADE, -- conversation the message belongs to
    sender_id INTEGER NOT NULL REFERENCES student(student_id), -- student who wrote the message
    body TEXT NOT NULL, -- message text
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time sent
    read_at TIMESTAMPTZ -- time the recipient read it (NULL = unread)
);

-- ---------- Notifications, moderation, alerts, activity ----------

CREATE TABLE notification (
    notification_id SERIAL PRIMARY KEY, -- surrogate key of the notification
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- recipient
    type TEXT NOT NULL, -- event type, e.g. OUTBID or PRICE_ALERT
    title TEXT NOT NULL, -- short title
    body TEXT NOT NULL, -- notification text
    related_listing_id INTEGER REFERENCES listing(listing_id) ON DELETE SET NULL, -- listing the event is about
    is_read BOOLEAN NOT NULL DEFAULT false, -- read flag
    created_at TIMESTAMPTZ NOT NULL DEFAULT now() -- time created
);

CREATE TABLE report (
    report_id SERIAL PRIMARY KEY, -- surrogate key of the report
    reporter_id INTEGER NOT NULL REFERENCES student(student_id), -- student filing the report
    reported_listing_id INTEGER REFERENCES listing(listing_id) ON DELETE SET NULL, -- reported listing (optional)
    reported_student_id INTEGER REFERENCES student(student_id), -- reported student (filled from the listing seller when omitted)
    reason TEXT NOT NULL, -- FAKE_LISTING, WRONG_DESCRIPTION, SCAM, SPAM or SUSPICIOUS_BEHAVIOR
    details TEXT, -- free-text explanation
    status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, DISMISSED, WARNED, LISTING_REMOVED or USER_SUSPENDED
    resolved_by INTEGER REFERENCES admin(admin_id), -- admin who handled the report
    resolved_at TIMESTAMPTZ, -- time the report was handled
    created_at TIMESTAMPTZ NOT NULL DEFAULT now() -- time the report was filed
);

CREATE TABLE price_alert (
    alert_id SERIAL PRIMARY KEY, -- surrogate key of the alert
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- student who set the alert
    book_id INTEGER NOT NULL REFERENCES book(book_id), -- book being watched
    max_price NUMERIC(10,2) NOT NULL, -- notify when a listing is at or below this price
    is_active BOOLEAN NOT NULL DEFAULT true, -- false once triggered
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the alert was created
    triggered_at TIMESTAMPTZ -- time a matching listing appeared
);

CREATE TABLE search_activity (
    search_id SERIAL PRIMARY KEY, -- surrogate key of the activity row
    student_id INTEGER REFERENCES student(student_id) ON DELETE SET NULL, -- searching student (NULL if anonymous)
    query_text TEXT NOT NULL DEFAULT '', -- the search text (empty for listing views)
    search_type TEXT NOT NULL DEFAULT 'FULLTEXT', -- FULLTEXT, SEMANTIC or VIEW
    book_id INTEGER REFERENCES book(book_id), -- book the search or view was about (if known)
    course_id INTEGER REFERENCES course(course_id), -- course the search or view was about (if known)
    searched_at TIMESTAMPTZ NOT NULL DEFAULT now() -- time of the activity
);
