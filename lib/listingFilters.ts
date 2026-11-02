// Marketplace filters -> SQL. One place, used by /api/listings and by the tests.
// All values go through $n parameters; LIKE wildcards typed by the user are escaped.
//
//   q            words typed by the student: EVERY word must appear (partly is fine) in the title, author, ISBN,
//                subject or course, OR the PostgreSQL full-text search must match ("alg" finds "Algorithms").
//   type         SALE / FIXED_PRICE (fixed price), AUCTION, SWAP (the owner is open to swaps)
//   availability available (default: only ACTIVE listings) | all (also reserved/sold/swapped ones, never removed ones)
//   campusId, department (name) / departmentId, courseId, courseCode, semester, isbn, category, condition,
//   minPrice, maxPrice, mine=1 (my own listings, any status except removed)
import { HttpError } from "./errors";

export const SORTS: Record<string, string> = {
  newest: "d.created_at DESC",
  price_asc: "d.current_price ASC, d.created_at DESC",
  price_desc: "d.current_price DESC, d.created_at DESC",
  ending: "d.auction_end_time ASC NULLS LAST, d.created_at DESC",
};
const CONDITIONS = ["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"];
const CATEGORIES = ["TEXTBOOK", "GOODS"];

export interface ListingQuery {
  where: string[];
  params: unknown[];
  orderBy: string;
  page: number;
  pageSize: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

function numberParam(sp: URLSearchParams, key: string, opts: { int?: boolean; min?: number; max?: number } = {}): number | null {
  const raw = (sp.get(key) ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || (opts.int && !Number.isInteger(n)) || (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
    throw new HttpError(400, `Invalid value for ${key}`);
  }
  return n;
}

export function buildListingQuery(sp: URLSearchParams, studentId: number): ListingQuery {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };

  if (sp.get("mine") === "1") {
    add("d.seller_id = ?", studentId);
    where.push("d.status <> 'REMOVED'");
  } else if ((sp.get("availability") ?? "available") === "all") {
    where.push("d.status IN ('ACTIVE', 'RESERVED', 'SOLD', 'SWAPPED')");
  } else {
    where.push("d.status = 'ACTIVE'");
  }

  // ---- text search
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  let rank = "0";
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
    const tokenSql: string[] = [];
    for (const token of tokens) {
      const like = `%${escapeLike(token)}%`;
      params.push(like);
      const a = params.length;
      let isbnPart = `d.isbn ILIKE $${a} ESCAPE '\\'`;
      if (/^[0-9Xx-]{4,}$/.test(token)) {
        params.push(`%${escapeLike(token.replace(/-/g, ""))}%`); // ISBN typed with hyphens
        isbnPart = `d.isbn ILIKE $${params.length} ESCAPE '\\'`;
      }
      tokenSql.push(
        `(d.title ILIKE $${a} ESCAPE '\\' OR d.author ILIKE $${a} ESCAPE '\\' OR ${isbnPart} OR d.subject ILIKE $${a} ESCAPE '\\'` +
        ` OR d.course_code ILIKE $${a} ESCAPE '\\' OR d.course_name ILIKE $${a} ESCAPE '\\')`
      );
    }
    params.push(q);
    const fts = `$${params.length}`;
    where.push(`((${tokenSql.join(" AND ")}) OR l.search_vector @@ websearch_to_tsquery('english', ${fts}))`);
    params.push(`%${escapeLike(q)}%`);
    rank = `(ts_rank(l.search_vector, websearch_to_tsquery('english', ${fts})) + CASE WHEN d.title ILIKE $${params.length} ESCAPE '\\' THEN 1 ELSE 0 END)`;
  }

  // ---- filters (all combine with AND)
  const campusId = numberParam(sp, "campusId", { int: true, min: 1 });
  if (campusId !== null) add("d.campus_id = ?", campusId);
  const courseId = numberParam(sp, "courseId", { int: true, min: 1 });
  if (courseId !== null) add("d.course_id = ?", courseId);
  const departmentId = numberParam(sp, "departmentId", { int: true, min: 1 });
  if (departmentId !== null) add("d.department_id = ?", departmentId);
  const department = (sp.get("department") ?? "").trim();
  if (department) add("d.department_name = ?", department); // by name: the same department exists on every campus
  const semester = numberParam(sp, "semester", { int: true, min: 1, max: 8 });
  if (semester !== null) add("d.course_semester = ?", semester);
  const courseCode = (sp.get("courseCode") ?? "").trim();
  if (courseCode) add("upper(d.course_code) = ?", courseCode.toUpperCase());
  const isbn = (sp.get("isbn") ?? "").replace(/[-\s]/g, "").toUpperCase();
  if (isbn) add("d.isbn = ?", isbn);

  const category = (sp.get("category") ?? "").toUpperCase();
  if (category) {
    if (!CATEGORIES.includes(category)) throw new HttpError(400, "Invalid category");
    add("d.category = ?", category);
  }
  const condition = (sp.get("condition") ?? "").toUpperCase();
  if (condition) {
    if (!CONDITIONS.includes(condition)) throw new HttpError(400, "Invalid condition");
    add("d.item_condition = ?", condition);
  }
  const type = (sp.get("type") ?? "").toUpperCase();
  if (type) {
    if (type === "SALE" || type === "FIXED_PRICE") add("d.listing_type = ?", "FIXED_PRICE");
    else if (type === "AUCTION") add("d.listing_type = ?", "AUCTION");
    else if (type === "SWAP") where.push("d.open_to_swap");
    else throw new HttpError(400, "Invalid listing type");
  }
  const minPrice = numberParam(sp, "minPrice", { min: 0 });
  const maxPrice = numberParam(sp, "maxPrice", { min: 0 });
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) throw new HttpError(400, "The minimum price is higher than the maximum price");
  if (minPrice !== null) add("d.current_price >= ?", minPrice);
  if (maxPrice !== null) add("d.current_price <= ?", maxPrice);

  const requested = sp.get("sort") ?? (q ? "relevance" : "newest");
  const orderBy = requested === "relevance" && q ? `${rank} DESC, d.created_at DESC` : SORTS[requested] ?? SORTS.newest;

  const pageSize = Math.min(Math.max(Math.floor(Number(sp.get("pageSize"))) || 12, 1), 50);
  const page = Math.max(Math.floor(Number(sp.get("page"))) || 1, 1);
  return { where, params, orderBy, page, pageSize };
}
