-- 007_pgvector.sql
-- Vector search with the pgvector extension (inside PostgreSQL, no extra database).
--
-- Embedding model : sentence-transformers/all-MiniLM-L6-v2
-- Dimension       : 384
-- Similarity      : cosine  (pgvector operator <=> is cosine DISTANCE; similarity = 1 - distance)
-- Index           : HNSW with vector_cosine_ops
-- Embedded text   : title, author, subject, course, edition, condition, description of a listing
--                   (built and embedded by scripts/generate_embeddings.py)

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE listing_embedding (
    listing_id INTEGER PRIMARY KEY REFERENCES listing(listing_id) ON DELETE CASCADE, -- listing the vector describes
    embedding vector(384) NOT NULL, -- 384-dimensional all-MiniLM-L6-v2 embedding of source_text
    source_text TEXT NOT NULL, -- exact text that was embedded
    model_name TEXT NOT NULL DEFAULT 'sentence-transformers/all-MiniLM-L6-v2', -- embedding model used
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- time the embedding was generated
);

CREATE INDEX idx_listing_embedding_hnsw ON listing_embedding USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- semantic_search: the application embeds the user's query with the same model and
-- passes the 384-number vector here. ORDER BY embedding <=> query LIMIT n uses the HNSW index.
-- ---------------------------------------------------------------------------
CREATE FUNCTION semantic_search(p_query vector(384), p_limit INTEGER DEFAULT 10, p_campus_id INTEGER DEFAULT NULL)
RETURNS TABLE (listing_id INTEGER, title TEXT, price NUMERIC, item_condition TEXT, similarity DOUBLE PRECISION)
LANGUAGE sql STABLE AS $$
    SELECT l.listing_id, l.title, l.price, l.item_condition,
           (1 - (e.embedding <=> p_query))::DOUBLE PRECISION AS similarity
    FROM listing_embedding e
    JOIN listing l ON l.listing_id = e.listing_id
    WHERE l.status = 'ACTIVE'
      AND (p_campus_id IS NULL OR l.campus_id = p_campus_id)
    ORDER BY e.embedding <=> p_query
    LIMIT p_limit;
$$;

-- ---------------------------------------------------------------------------
-- similar_listings: "More like this" - nearest neighbours of one listing's own vector
-- ---------------------------------------------------------------------------
CREATE FUNCTION similar_listings(p_listing_id INTEGER, p_limit INTEGER DEFAULT 5)
RETURNS TABLE (listing_id INTEGER, title TEXT, price NUMERIC, item_condition TEXT, similarity DOUBLE PRECISION)
LANGUAGE sql STABLE AS $$
    SELECT l.listing_id, l.title, l.price, l.item_condition,
           (1 - (e.embedding <=> src.embedding))::DOUBLE PRECISION AS similarity
    FROM listing_embedding src
    JOIN listing_embedding e ON e.listing_id <> src.listing_id
    JOIN listing l ON l.listing_id = e.listing_id
    WHERE src.listing_id = p_listing_id
      AND l.status = 'ACTIVE'
    ORDER BY e.embedding <=> src.embedding
    LIMIT p_limit;
$$;

-- ---------------------------------------------------------------------------
-- recommend_listings: understandable scoring for one student
--   score = cosine similarity to the average vector of the student's favorites (0 if none)
--         + 0.20 if the book's course belongs to the student's department
--         + 0.10 more if that course is taught in the student's current semester
--         + 0.10 if the student searched or viewed this book in the last 30 days
--         + 0.10 if the book's subject matches a book the student already bought
-- Uses AVG(vector) (pgvector 0.5 or newer).
-- ---------------------------------------------------------------------------
CREATE FUNCTION recommend_listings(p_student_id INTEGER, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (listing_id INTEGER, title TEXT, price NUMERIC, score DOUBLE PRECISION, reason TEXT)
LANGUAGE sql STABLE AS $$
    WITH me AS (
        SELECT student_id, department_id, semester FROM student WHERE student_id = p_student_id
    ),
    taste AS (
        SELECT AVG(e.embedding) AS v
        FROM wishlist w
        JOIN listing_embedding e ON e.listing_id = w.listing_id
        WHERE w.student_id = p_student_id
    )
    SELECT
        l.listing_id, l.title, l.price,
        (COALESCE(1 - (e.embedding <=> t.v), 0)
         + CASE WHEN co.department_id = me.department_id THEN 0.20 ELSE 0 END
         + CASE WHEN co.department_id = me.department_id AND co.semester = me.semester THEN 0.10 ELSE 0 END
         + CASE WHEN EXISTS (SELECT 1 FROM search_activity sa
                             WHERE sa.student_id = me.student_id AND sa.book_id = l.book_id
                               AND sa.searched_at >= now() - INTERVAL '30 days') THEN 0.10 ELSE 0 END
         + CASE WHEN EXISTS (SELECT 1 FROM transactions tx
                             JOIN listing pl ON pl.listing_id = tx.listing_id
                             JOIN book pb ON pb.book_id = pl.book_id
                             WHERE tx.buyer_id = me.student_id AND tx.state IN ('CONFIRMED', 'RELEASED')
                               AND pb.subject = b.subject) THEN 0.10 ELSE 0 END
        )::DOUBLE PRECISION AS score,
        CASE WHEN co.department_id = me.department_id AND co.semester = me.semester THEN 'Matches your department and semester'
             WHEN co.department_id = me.department_id THEN 'Matches your department'
             WHEN t.v IS NOT NULL THEN 'Similar to your favorites'
             ELSE 'Related to your activity' END AS reason
    FROM listing l
    JOIN listing_embedding e ON e.listing_id = l.listing_id
    LEFT JOIN book b ON b.book_id = l.book_id
    LEFT JOIN course co ON co.course_id = b.course_id
    CROSS JOIN me
    CROSS JOIN taste t
    WHERE l.status = 'ACTIVE'
      AND l.seller_id <> me.student_id
      AND NOT EXISTS (SELECT 1 FROM wishlist w WHERE w.student_id = me.student_id AND w.listing_id = l.listing_id)
    ORDER BY score DESC, l.created_at DESC
    LIMIT p_limit;
$$;
