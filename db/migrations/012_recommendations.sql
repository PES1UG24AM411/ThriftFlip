-- 012_recommendations.sql
-- WHY /recommendations was empty: recommend_listings() (007) INNER JOINed listing_embedding, so it returned
-- nothing until `npm run embeddings:generate` had been run, and the API fallback needed a book -> course ->
-- department chain that many listings do not have.
-- Now every ACTIVE listing of another student is a candidate and gets points from simple rules; embeddings are an
-- optional bonus. Ranking = score DESC, newest first, so with no personal data at all the result is simply
-- "recently listed textbooks". Same signature/columns as before (CREATE OR REPLACE).
--
--   +30 course of the book is in the student's department        +20 and taught in the student's semester
--   +25 same book as a wishlisted listing  +10 same course  +8 same subject
--   +20 book searched/viewed in the last 30 days  +10 same course as a recent search/view
--   +10 subject of a book the student bought or swapped for
--   +20 * cosine similarity to the wishlist taste vector (only when embeddings exist)
--   +8 same campus   +5 textbook
-- Excluded: own listings, listings that are not ACTIVE, listings already on the wishlist.
CREATE OR REPLACE FUNCTION recommend_listings(p_student_id INTEGER, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (listing_id INTEGER, title TEXT, price NUMERIC, score DOUBLE PRECISION, reason TEXT)
LANGUAGE sql STABLE AS $$
    WITH me AS (
        SELECT student_id, department_id, semester, campus_id FROM student WHERE student_id = p_student_id
    ),
    taste AS (
        SELECT AVG(e.embedding) AS v
        FROM wishlist w JOIN listing_embedding e ON e.listing_id = w.listing_id
        WHERE w.student_id = p_student_id
    ),
    wish AS (
        SELECT l.book_id, b.subject, b.course_id
        FROM wishlist w JOIN listing l ON l.listing_id = w.listing_id LEFT JOIN book b ON b.book_id = l.book_id
        WHERE w.student_id = p_student_id
    ),
    recent AS (
        SELECT sa.book_id, sa.course_id FROM search_activity sa
        WHERE sa.student_id = p_student_id AND sa.searched_at >= now() - INTERVAL '30 days'
    ),
    bought AS (
        SELECT DISTINCT pb.subject
        FROM transactions tx JOIN listing pl ON pl.listing_id = tx.listing_id JOIN book pb ON pb.book_id = pl.book_id
        WHERE tx.buyer_id = p_student_id AND tx.state = 'RELEASED'
    ),
    cand AS (
        SELECT l.listing_id, l.title, l.price, l.created_at, l.category, l.campus_id,
               (co.department_id = me.department_id) AS dept_match,
               (co.department_id = me.department_id AND co.semester = me.semester) AS sem_match,
               EXISTS (SELECT 1 FROM wish w WHERE w.book_id IS NOT NULL AND w.book_id = l.book_id) AS wish_book,
               EXISTS (SELECT 1 FROM wish w WHERE w.course_id IS NOT NULL AND w.course_id = b.course_id) AS wish_course,
               EXISTS (SELECT 1 FROM wish w WHERE w.subject IS NOT NULL AND w.subject = b.subject) AS wish_subject,
               EXISTS (SELECT 1 FROM recent r WHERE r.book_id IS NOT NULL AND r.book_id = l.book_id) AS recent_book,
               EXISTS (SELECT 1 FROM recent r WHERE r.course_id IS NOT NULL AND r.course_id = b.course_id) AS recent_course,
               EXISTS (SELECT 1 FROM bought x WHERE x.subject = b.subject) AS bought_subject,
               (me.campus_id = l.campus_id) AS same_campus,
               CASE WHEN t.v IS NOT NULL AND e.embedding IS NOT NULL THEN GREATEST(0, 1 - (e.embedding <=> t.v)) ELSE 0 END AS sim,
               (t.v IS NOT NULL AND e.embedding IS NOT NULL) AS has_sim
        FROM listing l
        CROSS JOIN me
        CROSS JOIN taste t
        LEFT JOIN listing_embedding e ON e.listing_id = l.listing_id
        LEFT JOIN book b ON b.book_id = l.book_id
        LEFT JOIN course co ON co.course_id = b.course_id
        WHERE l.status = 'ACTIVE'
          AND l.seller_id <> me.student_id
          AND NOT EXISTS (SELECT 1 FROM wishlist w WHERE w.student_id = me.student_id AND w.listing_id = l.listing_id)
    )
    SELECT c.listing_id, c.title, c.price,
           (  CASE WHEN c.dept_match THEN 30 ELSE 0 END + CASE WHEN c.sem_match THEN 20 ELSE 0 END
            + CASE WHEN c.wish_book THEN 25 ELSE 0 END + CASE WHEN c.wish_course THEN 10 ELSE 0 END
            + CASE WHEN c.wish_subject THEN 8 ELSE 0 END
            + CASE WHEN c.recent_book THEN 20 ELSE 0 END + CASE WHEN c.recent_course THEN 10 ELSE 0 END
            + CASE WHEN c.bought_subject THEN 10 ELSE 0 END
            + 20 * c.sim
            + CASE WHEN c.same_campus THEN 8 ELSE 0 END + CASE WHEN c.category = 'TEXTBOOK' THEN 5 ELSE 0 END
           )::DOUBLE PRECISION AS score,
           CASE WHEN c.sem_match THEN 'Matches your department and semester'
                WHEN c.dept_match THEN 'Matches your department'
                WHEN c.wish_book OR c.wish_course OR c.wish_subject THEN 'Related to your wishlist'
                WHEN c.has_sim AND c.sim > 0.5 THEN 'Similar to your favorites'
                WHEN c.recent_book OR c.recent_course THEN 'Matches your recent searches'
                WHEN c.bought_subject THEN 'Related to a book you bought'
                WHEN c.same_campus AND c.category = 'TEXTBOOK' THEN 'Available on your campus'
                ELSE 'Recently listed' END AS reason
    FROM cand c
    ORDER BY score DESC, c.created_at DESC, c.listing_id DESC
    LIMIT p_limit;
$$;
