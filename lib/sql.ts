// Column list shared by the listing queries (card view of v_listing_details, alias d).
export const LISTING_CARD_COLUMNS = `
  d.listing_id, d.title, d.category, d.item_condition, d.listing_type, d.price, d.current_price,
  d.status, d.open_to_swap, d.seller_id, d.seller_name, d.seller_avg_rating, d.seller_rating_count, d.wanted_books, d.campus_name,
  d.book_id, d.isbn, d.author, d.edition, d.subject, d.course_id, d.course_code, d.course_semester, d.department_id,
  d.department_name, d.cover_image_id, to_jsonb(d)->>'cover_url' AS cover_url, d.auction_end_time, d.wishlist_count
`;
