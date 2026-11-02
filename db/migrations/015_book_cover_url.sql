-- 015_book_cover_url.sql
-- Online cover image of a book (for example an Open Library link). Only the LINK is stored; nothing is downloaded.
-- IF NOT EXISTS: a database where the column was already added by hand keeps its data untouched.
-- WHY the covers did not show: the column existed only in the table. v_listing_details (used by every listing query)
-- did not select it, and the pages only knew about photos uploaded by students.
-- Display order in the pages: student-uploaded photo, then cover_url, then a placeholder.
ALTER TABLE book ADD COLUMN IF NOT EXISTS cover_url TEXT;

-- a new column is appended at the end of the view, so CREATE OR REPLACE is allowed
CREATE OR REPLACE VIEW v_listing_details AS
SELECT
    l.listing_id, l.title, l.description, l.category, l.item_condition, l.listing_type,
    l.price, l.status, l.open_to_swap, l.created_at,
    l.seller_id, s.name AS seller_name, rep.reputation_score AS seller_reputation,
    l.campus_id, c.name AS campus_name,
    b.book_id, b.isbn, b.author, b.edition, b.subject,
    co.course_id, co.code AS course_code, co.name AS course_name,
    a.auction_id, a.end_time AS auction_end_time,
    COALESCE(a.current_price, l.price) AS current_price,
    dep.department_id AS department_id, dep.name AS department_name, co.semester AS course_semester,
    (SELECT li.image_id FROM listing_image li WHERE li.listing_id = l.listing_id ORDER BY li.position, li.image_id LIMIT 1) AS cover_image_id,
    (SELECT COUNT(*) FROM wishlist w WHERE w.listing_id = l.listing_id) AS wishlist_count,
    b.cover_url AS cover_url
FROM listing l
JOIN student s ON s.student_id = l.seller_id
JOIN campus c ON c.campus_id = l.campus_id
JOIN v_student_reputation rep ON rep.student_id = l.seller_id
LEFT JOIN book b ON b.book_id = l.book_id
LEFT JOIN course co ON co.course_id = b.course_id
LEFT JOIN department dep ON dep.department_id = co.department_id
LEFT JOIN auction a ON a.listing_id = l.listing_id;
