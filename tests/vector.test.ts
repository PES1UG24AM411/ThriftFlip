import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, one, vec } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
let seller: number;
beforeEach(async () => { await resetData(); base = await setupCampus(); seller = await makeStudent(base, "Seller"); });
afterAll(async () => { await pool.end(); });

async function embedded(title: string, vector: string, status = "ACTIVE") {
  const l = await makeListing(seller, base.campus, null, { title });
  if (status !== "ACTIVE") await pool.query("UPDATE listing SET status = $2 WHERE listing_id = $1", [l, status]);
  await pool.query("INSERT INTO listing_embedding (listing_id, embedding, source_text) VALUES ($1, $2::vector, $3)", [l, vector, title]);
  return l;
}

// Synthetic 384-dimensional vectors: these tests check the SQL side (storage, cosine ordering, filters, index).
describe("pgvector storage and cosine similarity", () => {
  it("stores 384-dimensional vectors and rejects other dimensions", async () => {
    const l = await embedded("a", vec(1));
    expect((await one("SELECT vector_dims(embedding) AS d FROM listing_embedding WHERE listing_id = $1", [l])).d).toBe(384);
    const l2 = await makeListing(seller, base.campus, null);
    await expect(pool.query("INSERT INTO listing_embedding (listing_id, embedding, source_text) VALUES ($1, '[1,2,3]'::vector, 'x')", [l2])).rejects.toThrow(/dimensions/);
  });

  it("semantic_search orders by cosine similarity (1 - cosine distance)", async () => {
    const near = await embedded("near", vec(1, 0.1));
    const mid = await embedded("mid", vec(1, 1));
    const far = await embedded("far", vec(0, 1));
    const rows = (await pool.query("SELECT * FROM semantic_search($1::vector, 10, NULL)", [vec(1, 0)])).rows;
    expect(rows.map((r) => r.listing_id)).toEqual([near, mid, far]);
    expect(rows[0].similarity).toBeCloseTo(0.995, 2);
    expect(rows[1].similarity).toBeCloseTo(0.7071, 3);
    expect(rows[2].similarity).toBeCloseTo(0, 5);
  });

  it("cosine ignores vector length (a vector 10x longer ranks the same)", async () => {
    const small = await embedded("small", vec(0.1, 0.01));
    const big = await embedded("big", vec(0.2, 0.9));
    const rows = (await pool.query("SELECT * FROM semantic_search($1::vector, 10, NULL)", [vec(10, 0)])).rows;
    expect(rows[0].listing_id).toBe(small);
    expect(rows[0].similarity).toBeGreaterThan(rows[1].similarity);
    expect(rows[1].listing_id).toBe(big);
  });

  it("only ACTIVE listings are returned, the limit is applied, and the campus filter works", async () => {
    await embedded("sold", vec(1), "SOLD");
    const active = await embedded("active", vec(1, 0.5));
    await embedded("other", vec(0, 0, 1));
    expect((await pool.query("SELECT * FROM semantic_search($1::vector, 10, NULL)", [vec(1)])).rows.map((r) => r.listing_id)).not.toContain(active - 1);
    expect((await pool.query("SELECT * FROM semantic_search($1::vector, 1, NULL)", [vec(1)])).rows).toHaveLength(1);
    const otherCampus = (await one("INSERT INTO campus (name, city) VALUES ('Other', 'Y') RETURNING campus_id")).campus_id;
    expect((await pool.query("SELECT * FROM semantic_search($1::vector, 10, $2::int)", [vec(1), otherCampus])).rows).toHaveLength(0);
  });

  it("similar_listings returns the nearest neighbours of one listing, never itself", async () => {
    const a = await embedded("a", vec(1, 0));
    const b = await embedded("b", vec(0.9, 0.1));
    const c = await embedded("c", vec(0, 1));
    const rows = (await pool.query("SELECT * FROM similar_listings($1::int, 5)", [a])).rows;
    expect(rows.map((r) => r.listing_id)).toEqual([b, c]);
  });

  it("recommend_listings uses the wishlist vector and the student's course", async () => {
    const student = await makeStudent(base, "Reader");
    const liked = await embedded("liked", vec(1, 0));
    const similar = await embedded("similar", vec(0.95, 0.05));
    const different = await embedded("different", vec(0, 1));
    await pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2)", [student, liked]);
    const rows = (await pool.query("SELECT * FROM recommend_listings($1::int, 5)", [student])).rows;
    expect(rows[0].listing_id).toBe(similar);               // closest to the wishlist taste
    expect(rows.map((r) => r.listing_id)).not.toContain(liked); // already wishlisted
    expect(rows.map((r) => r.listing_id)).toContain(different);
    expect(rows[0].reason).toBe("Similar to your favorites");
  });

  it("deleting a listing removes its embedding (ON DELETE CASCADE) and the HNSW cosine index exists", async () => {
    const l = await embedded("gone", vec(1));
    await pool.query("DELETE FROM listing WHERE listing_id = $1", [l]);
    expect((await one("SELECT COUNT(*)::int AS n FROM listing_embedding")).n).toBe(0);
    const idx = await one("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_listing_embedding_hnsw'");
    expect(idx.indexdef).toMatch(/hnsw/i);
    expect(idx.indexdef).toMatch(/vector_cosine_ops/);
  });
});

// Needs the real model (downloads ~90 MB on first run, internet required). Run with RUN_MODEL_TESTS=1.
describe.skipIf(!process.env.RUN_MODEL_TESTS)("real embedding model (all-MiniLM-L6-v2)", () => {
  it("produces 384 numbers and ranks a semantically related listing first without exact keywords", async () => {
    const { embedText, toVectorLiteral } = await import("../lib/embeddings/embed");
    const ml = await embedText("Pattern Recognition and Machine Learning by Bishop. subject: Machine Learning. course: Machine Learning");
    const cooking = await embedText("Stainless steel frying pan set for the hostel kitchen");
    expect(ml).toHaveLength(384);
    const lMl = await embedded("ml book", toVectorLiteral(ml));
    await embedded("pan", toVectorLiteral(cooking));
    const query = await embedText("third year machine learning textbook");
    const rows = (await pool.query("SELECT * FROM semantic_search($1::vector, 5, NULL)", [toVectorLiteral(query)])).rows;
    expect(rows[0].listing_id).toBe(lMl);
  }, 120000);
});
