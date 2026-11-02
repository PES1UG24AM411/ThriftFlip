// Seeds realistic demo data. It goes through the same SQL functions as the application
// (place_bid, close_auction, create_purchase, transition_transaction,
// admin_set_report_status ...), so triggers and business rules run exactly as in real use.
//
//   npm run db:seed            seeds once; if the demo data already exists it does nothing, and it refuses to
//                              add demo accounts to a database that already holds students or listings
//   npm run db:seed -- --force --confirm=<database name>
//                              deletes ALL data in the public tables and seeds again (refuses without --confirm)
//
// Demo accounts (local use only, passwords can be changed with SEED_DEMO_PASSWORD / SEED_ADMIN_PASSWORD):
//   students  <firstname>.<lastname>@thriftflip.test   e.g. aarav.sharma@thriftflip.test
//   admin     admin@thriftflip.test

import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { config } from "dotenv";
import { requireDeleteConfirmation } from "./confirmDestructive";

config({ path: ".env.local" });
config();

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "Demo@12345";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Admin@12345";
const MARKER_SRN = "PES1UG23CS001";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Row = Record<string, unknown>;

async function insert(c: Client, table: string, idCol: string, row: Row): Promise<number> {
  const cols = Object.keys(row);
  const params = cols.map((_, i) => `$${i + 1}`);
  const res = await c.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${params.join(", ")}) RETURNING ${idCol}`,
    Object.values(row)
  );
  return res.rows[0][idCol] as number;
}

async function seedAll(c: Client) {
  const now = Date.now();
  const at = (offsetMs: number) => new Date(now + offsetMs);

  // ---------------------------------------------------------------- reference data, departments, courses
  // Campus, the six B.Tech departments and the college e-mail domain come from migration 008
  // (a --force reset empties the tables, so the same SQL file is run again; it is idempotent).
  await c.query(readFileSync(path.join(process.cwd(), "db", "migrations", "008_reference_data.sql"), "utf8"));
  await c.query("INSERT INTO college_email_domain (domain) VALUES ('thriftflip.test') ON CONFLICT DO NOTHING"); // demo accounts only

  const campusId = async (name: string) =>
    (await c.query("SELECT campus_id FROM campus WHERE name = $1", [name])).rows[0].campus_id as number;
  const rr = await campusId("RR Campus");
  const ec = await campusId("EC Campus");
  const deptId = async (campus: number, name: string) =>
    (await c.query("SELECT department_id FROM department WHERE campus_id = $1 AND name = $2", [campus, name])).rows[0].department_id as number;
  // The demo course catalogue is attached to the RR campus departments; EC students use the same course codes.
  const dept = {
    cse: await deptId(rr, "CSE"),
    aiml: await deptId(rr, "CSE (AI & ML)"),
    bio: await deptId(rr, "Biotechnology"),
    ece: await deptId(rr, "ECE"),
    eee: await deptId(rr, "EEE"),
    mech: await deptId(rr, "Mechanical"),
  };
  const deptEc = { cse: await deptId(ec, "CSE"), aiml: await deptId(ec, "CSE (AI & ML)"), ece: await deptId(ec, "ECE") };

  // Demo course catalogue: course code, name, semester in which it is taught
  const mkCourse = (department_id: number, code: string, name: string, semester: number) =>
    insert(c, "course", "course_id", { department_id, code, name, semester });
  const course = {
    math: await mkCourse(dept.cse, "UE23MA141A", "Engineering Mathematics", 1),
    la: await mkCourse(dept.cse, "UE23MA241B", "Linear Algebra", 2),
    dsa: await mkCourse(dept.cse, "UE23CS201A", "Data Structures and Algorithms", 3),
    os: await mkCourse(dept.cse, "UE23CS242B", "Operating Systems", 4),
    dbms: await mkCourse(dept.cse, "UE23CS351A", "Database Management Systems", 5),
    ml: await mkCourse(dept.cse, "UE23CS352A", "Machine Learning", 6),
    cn: await mkCourse(dept.cse, "UE23CS252B", "Computer Networks", 5),
    ai: await mkCourse(dept.aiml, "UE23AM351A", "Artificial Intelligence", 5),
    dd: await mkCourse(dept.ece, "UE23EC141A", "Digital Design and Computer Organization", 3),
    machines: await mkCourse(dept.eee, "UE23EE241A", "Electrical Machines", 4),
    thermo: await mkCourse(dept.mech, "UE23ME241A", "Engineering Thermodynamics", 4),
    biochem: await mkCourse(dept.bio, "UE23BT141A", "Biochemistry", 2),
  };

  // ---------------------------------------------------------------- books (ISBNs are illustrative demo data)
  const mkBook = (isbn: string, title: string, author: string, edition: number, subject: string, course_id: number) =>
    insert(c, "book", "book_id", { isbn, title, author, edition, subject, course_id });
  const book = {
    prml: await mkBook("9780387310732", "Pattern Recognition and Machine Learning", "Christopher M. Bishop", 1, "Machine Learning", course.ml),
    geron: await mkBook("9781098125974", "Hands-On Machine Learning with Scikit-Learn, Keras and TensorFlow", "Aurelien Geron", 3, "Machine Learning", course.ml),
    dl: await mkBook("9780262035613", "Deep Learning", "Ian Goodfellow, Yoshua Bengio, Aaron Courville", 1, "Machine Learning", course.ml),
    aima: await mkBook("9780134610993", "Artificial Intelligence: A Modern Approach", "Stuart Russell, Peter Norvig", 4, "Artificial Intelligence", course.ai),
    clrs: await mkBook("9780262046305", "Introduction to Algorithms", "Cormen, Leiserson, Rivest, Stein", 4, "Algorithms", course.dsa),
    dbc: await mkBook("9780078022159", "Database System Concepts", "Silberschatz, Korth, Sudarshan", 7, "Databases", course.dbms),
    elm: await mkBook("9780133970777", "Fundamentals of Database Systems", "Ramez Elmasri, Shamkant Navathe", 7, "Databases", course.dbms),
    kreyszig: await mkBook("9780470458365", "Advanced Engineering Mathematics", "Erwin Kreyszig", 10, "Engineering Mathematics", course.math),
    strang: await mkBook("9780980232776", "Introduction to Linear Algebra", "Gilbert Strang", 5, "Linear Algebra", course.la),
    mano: await mkBook("9780133071429", "Digital Design", "M. Morris Mano, Michael Ciletti", 5, "Digital Electronics", course.dd),
    osc: await mkBook("9781119800361", "Operating System Concepts", "Silberschatz, Galvin, Gagne", 10, "Operating Systems", course.os),
    kurose: await mkBook("9780136681557", "Computer Networking: A Top-Down Approach", "James Kurose, Keith Ross", 8, "Computer Networks", course.cn),
  };
  type BookKey = keyof typeof book;

  // ---------------------------------------------------------------- admin and students
  const adminId = await insert(c, "admin", "admin_id", {
    name: "THRIFTFLIP Admin",
    email: "admin@thriftflip.test",
    password_hash: await bcrypt.hash(ADMIN_PASSWORD, 10),
  });

  const studentDefs = [
    { key: "aarav", srn: "PES1UG23CS001", name: "Aarav Sharma", dept: dept.cse, sem: 6 },
    { key: "diya", srn: "PES1UG23CS002", name: "Diya Iyer", dept: dept.cse, sem: 5 },
    { key: "rohan", srn: "PES1UG23CS003", name: "Rohan Mehta", dept: dept.cse, sem: 6 },
    { key: "karthik", srn: "PES1UG22CS004", name: "Karthik Nair", dept: dept.cse, sem: 7 },
    { key: "meera", srn: "PES2UG24EC005", name: "Meera Krishnan", dept: deptEc.ece, campus: ec, sem: 3 },
    { key: "ishaan", srn: "PES1UG24AM006", name: "Ishaan Verma", dept: dept.aiml, sem: 3 },
    { key: "sneha", srn: "PES1UG25BT007", name: "Sneha Reddy", dept: dept.bio, sem: 1 },
    { key: "vikram", srn: "PES2UG23AM008", name: "Vikram Rao", dept: deptEc.aiml, campus: ec, sem: 5 },
    { key: "ananya", srn: "PES2UG23CS009", name: "Ananya Pillai", dept: deptEc.cse, campus: ec, sem: 6 },
    { key: "tanvi", srn: "PES1UG23CS010", name: "Tanvi Desai", dept: dept.cse, sem: 6 },
    { key: "arjun", srn: "PES1UG22EE011", name: "Arjun Menon", dept: dept.eee, sem: 7 },
    { key: "priya", srn: "PES1UG24ME012", name: "Priya Shah", dept: dept.mech, sem: 3 },
  ];
  const S: Record<string, { id: number; campus: number }> = {};
  for (const s of studentDefs) {
    const id = await insert(c, "student", "student_id", {
      srn: s.srn,
      name: s.name,
      email: `${s.name.toLowerCase().replace(" ", ".")}@thriftflip.test`,
      password_hash: await bcrypt.hash(DEMO_PASSWORD, 10),
      department_id: s.dept, // campus is filled by a trigger, program defaults to B.Tech
      semester: s.sem,
      email_verified: true,
      email_verified_at: new Date(),
    });
    S[s.key] = { id, campus: (s as { campus?: number }).campus ?? rr };
  }

  // ---------------------------------------------------------------- helpers
  async function addListing(
    seller: string,
    bookKey: BookKey | null,
    o: { title: string; description: string; cond: string; price: number; type?: string; swap?: boolean }
  ): Promise<number> {
    return insert(c, "listing", "listing_id", {
      seller_id: S[seller].id,
      book_id: bookKey ? book[bookKey] : null,
      campus_id: S[seller].campus,
      category: bookKey ? "TEXTBOOK" : "GOODS",
      title: o.title,
      description: o.description,
      item_condition: o.cond,
      listing_type: o.type ?? "FIXED_PRICE",
      price: o.price,
      open_to_swap: o.swap ?? false,
    });
  }

  async function transition(txId: number, state: string, actorType: string, actorId: number | null) {
    await c.query("SELECT transition_transaction($1::int, $2::text, $3::text, $4::int)", [txId, state, actorType, actorId]);
    await c.query("SELECT set_config('app.actor_type', '', true), set_config('app.actor_id', '', true)");
  }

  // Moves a transaction along the state machine up to (and including) targetState.
  async function advance(txId: number, buyer: string, seller: string, targetState: string) {
    const steps: Array<[string, string, number | null]> = [
      ["PAYMENT_HELD", "STUDENT", S[buyer].id],
      ["HANDED_OFF", "STUDENT", S[seller].id],
      ["CONFIRMED", "STUDENT", S[buyer].id],
      ["RELEASED", "SYSTEM", null],
    ];
    for (const [state, actor, actorId] of steps) {
      await transition(txId, state, actor, actorId);
      if (state === targetState) return;
    }
  }

  async function purchase(listingId: number, buyer: string): Promise<number> {
    const res = await c.query("SELECT create_purchase($1::int, $2::int) AS id", [listingId, S[buyer].id]);
    return res.rows[0].id as number;
  }

  async function sale(
    seller: string,
    buyer: string,
    bookKey: BookKey,
    o: { title: string; description: string; cond: string; price: number },
    target: string
  ): Promise<number> {
    const listingId = await addListing(seller, bookKey, o);
    const txId = await purchase(listingId, buyer);
    if (target !== "PENDING") await advance(txId, buyer, seller, target);
    return txId;
  }

  async function addAuction(listingId: number, start: Date, end: Date, minIncrement: number): Promise<number> {
    const price = (await c.query("SELECT price FROM listing WHERE listing_id = $1", [listingId])).rows[0].price;
    return insert(c, "auction", "auction_id", {
      listing_id: listingId,
      starting_price: price,
      min_increment: minIncrement,
      start_time: start,
      end_time: end,
    });
  }

  async function bid(auctionId: number, bidder: string, amount: number, when: Date) {
    await c.query("SELECT * FROM place_bid($1::int, $2::int, $3::numeric, $4::timestamptz)", [
      auctionId, S[bidder].id, amount, when,
    ]);
  }

  // Closes an auction at its (possibly extended) end time. Returns the AUCTION_WIN transaction id.
  async function closeAuction(auctionId: number): Promise<number> {
    const end = (await c.query("SELECT end_time FROM auction WHERE auction_id = $1", [auctionId])).rows[0].end_time;
    const res = await c.query("SELECT close_auction($1::int, $2::timestamptz) AS id", [auctionId, end]);
    return res.rows[0].id as number;
  }

  async function rate(txId: number, rater: string, ratee: string, score: number, review?: string) {
    const ratingId = await insert(c, "rating", "rating_id", {
      transaction_id: txId, rater_id: S[rater].id, ratee_id: S[ratee].id, score,
    });
    if (review) await insert(c, "review", "review_id", { rating_id: ratingId, body: review });
  }

  // ---------------------------------------------------------------- fixed-price listings (marketplace)
  const L1 = await addListing("aarav", "prml", { title: "Pattern Recognition and Machine Learning (Bishop)", description: "Light highlighting in chapters 1 to 5, no torn pages. Good for the third year machine learning course.", cond: "GOOD", price: 650 });
  const L2 = await addListing("diya", "geron", { title: "Hands-On Machine Learning (Geron, 3rd edition)", description: "Almost new, only used for one semester. Practical book with scikit-learn and Keras code examples.", cond: "LIKE_NEW", price: 900 });
  await addListing("rohan", "aima", { title: "Artificial Intelligence: A Modern Approach (Russell and Norvig)", description: "Clean copy, covers search, logic, probability and learning. Useful for AI electives.", cond: "GOOD", price: 750 });
  const L9 = await addListing("ishaan", "clrs", { title: "Introduction to Algorithms (CLRS 4th edition)", description: "Standard algorithms reference. Cover is worn but all pages intact.", cond: "FAIR", price: 800 });
  const L10 = await addListing("vikram", "dbc", { title: "Database System Concepts (Silberschatz, 7th edition)", description: "Core DBMS textbook: SQL, normalization, transactions, indexing. No writing inside.", cond: "LIKE_NEW", price: 850 });
  const L11 = await addListing("ananya", "dl", { title: "Deep Learning (Goodfellow, Bengio, Courville)", description: "Neural networks, optimization and regularization. Some pencil notes in the margins.", cond: "GOOD", price: 700 });
  const L13 = await addListing("arjun", "elm", { title: "Fundamentals of Database Systems (Elmasri and Navathe)", description: "ER modelling, relational algebra and query processing. Fifth year DBMS elective copy.", cond: "GOOD", price: 600 });
  await addListing("priya", null, { title: "Arduino Uno starter kit", description: "Board, breadboard, sensors and jumper wires. Everything works, box included.", cond: "GOOD", price: 900 });

  // ---------------------------------------------------------------- swap listings and preferences
  // Direct swap:    Diya (Operating System Concepts) <-> Arjun (Computer Networking)
  // Three-way swap: Tanvi (Linear Algebra) -> wants Kreyszig (Sneha) -> Sneha wants Digital Design (Meera) -> Meera wants Linear Algebra (Tanvi)
  const swapOsc = await addListing("diya", "osc", { title: "Operating System Concepts (Silberschatz, 10th edition)", description: "Dinosaur book for the OS course. Looking to swap for a networking book.", cond: "GOOD", price: 550, swap: true });
  const swapCn = await addListing("arjun", "kurose", { title: "Computer Networking: A Top-Down Approach (Kurose and Ross)", description: "Chapters on TCP, routing and the application layer. Happy to swap for an OS book.", cond: "GOOD", price: 520, swap: true });
  const swapStrang = await addListing("tanvi", "strang", { title: "Introduction to Linear Algebra (Strang, 5th edition)", description: "Clear explanations of vector spaces and eigenvalues. Open to swaps.", cond: "LIKE_NEW", price: 500, swap: true });
  const swapKreyszig = await addListing("sneha", "kreyszig", { title: "Advanced Engineering Mathematics (Kreyszig, 10th edition)", description: "First year calculus, differential equations and Fourier series. Open to swaps.", cond: "GOOD", price: 450, swap: true });
  const swapMano = await addListing("meera", "mano", { title: "Digital Design (Mano and Ciletti, 5th edition)", description: "Logic gates, flip-flops and state machines. Open to swaps.", cond: "GOOD", price: 400, swap: true });

  const pref = (student: string, offered: number, wanted: BookKey) =>
    insert(c, "swap_preference", "preference_id", { student_id: S[student].id, offered_listing_id: offered, wanted_book_id: book[wanted] });
  // wanted books shown on the card and the listing page: one from the catalogue, one typed title
  await c.query("INSERT INTO listing_wanted_book (listing_id, book_id) VALUES ($1, $2)", [swapOsc, book.kurose]);
  await c.query("INSERT INTO listing_wanted_book (listing_id, custom_title) VALUES ($1, 'Any computer networks textbook')", [swapOsc]);
  await pref("diya", swapOsc, "kurose");
  await pref("arjun", swapCn, "osc");
  await pref("tanvi", swapStrang, "kreyszig");
  await pref("sneha", swapKreyszig, "mano");
  await pref("meera", swapMano, "strang");
  await pref("aarav", L1, "dl"); // no match: the Deep Learning listing is not open to swaps

  // ---------------------------------------------------------------- sales history (feeds fair price)
  const history: Array<{ tx: number; buyer: string; seller: string }> = [];
  const hist = async (seller: string, buyer: string, bookKey: BookKey, title: string, cond: string, price: number) => {
    const tx = await sale(seller, buyer, bookKey, { title, description: `${title}, sold during the previous semester.`, cond, price }, "RELEASED");
    history.push({ tx, buyer, seller });
  };
  await hist("arjun", "ananya", "prml", "Pattern Recognition and Machine Learning (Bishop)", "GOOD", 620);
  await hist("priya", "tanvi", "prml", "Pattern Recognition and Machine Learning (Bishop)", "FAIR", 540);
  await hist("vikram", "aarav", "geron", "Hands-On Machine Learning (Geron, 3rd edition)", "LIKE_NEW", 880);
  await hist("ishaan", "diya", "geron", "Hands-On Machine Learning (Geron, 3rd edition)", "GOOD", 800);
  await hist("ishaan", "arjun", "dbc", "Database System Concepts (Silberschatz, 7th edition)", "GOOD", 780);
  await hist("tanvi", "sneha", "kreyszig", "Advanced Engineering Mathematics (Kreyszig, 10th edition)", "GOOD", 400);
  await hist("ananya", "priya", "kreyszig", "Advanced Engineering Mathematics (Kreyszig, 10th edition)", "FAIR", 350);
  await hist("aarav", "ananya", "dl", "Deep Learning (Goodfellow, Bengio, Courville)", "GOOD", 640);
  await hist("diya", "ishaan", "clrs", "Introduction to Algorithms (CLRS 4th edition)", "FAIR", 700);
  await hist("sneha", "tanvi", "strang", "Introduction to Linear Algebra (Strang, 5th edition)", "GOOD", 450);

  const ratingTexts: Array<[number, number, string | undefined]> = [
    [0, 5, "Book exactly as described, quick handover at the library."],
    [1, 4, undefined],
    [2, 5, "Like new as promised. Would buy from again."],
    [3, 4, "Good deal, a few highlighted lines."],
    [4, 5, undefined],
    [5, 5, "Friendly and on time."],
    [6, 3, "Book was more worn than the photos suggested."],
    [7, 5, undefined],
    [8, 4, "Smooth swap of cash for book."],
    [9, 5, "Great condition."],
  ];
  for (const [i, score, text] of ratingTexts) {
    const h = history[i];
    await rate(h.tx, h.buyer, h.seller, score, text);
    if (i % 2 === 0) await rate(h.tx, h.seller, h.buyer, 5); // sellers rate buyers for some deals
  }

  // ---------------------------------------------------------------- transactions in every state
  const pending = await sale("aarav", "ishaan", "clrs", { title: "Introduction to Algorithms (CLRS 4th edition)", description: "Hardcover, minimal highlighting.", cond: "GOOD", price: 1000 }, "PENDING");
  const held = await sale("ananya", "vikram", "elm", { title: "Fundamentals of Database Systems (Elmasri and Navathe)", description: "Payment is held while we arrange the handover.", cond: "GOOD", price: 550 }, "PAYMENT_HELD");
  const handed = await sale("tanvi", "priya", "dl", { title: "Deep Learning (Goodfellow, Bengio, Courville)", description: "Handed over at the canteen, waiting for confirmation.", cond: "FAIR", price: 500 }, "HANDED_OFF");
  const confirmed = await sale("arjun", "diya", "dbc", { title: "Database System Concepts (Silberschatz, 7th edition)", description: "Buyer has confirmed receiving the book.", cond: "GOOD", price: 700 }, "CONFIRMED");
  void pending; void held; void handed; void confirmed;
  // Ratings are only allowed once the money is RELEASED (validate_rating, migration 011), so the review belongs to a completed deal.
  const rated = await sale("arjun", "diya", "dbc", { title: "Database System Concepts (Silberschatz, 6th edition)", description: "Completed deal: the buyer confirmed the handover and the payment was released.", cond: "GOOD", price: 650 }, "RELEASED");
  await rate(rated, "diya", "arjun", 5, "Exactly the edition I needed for the DBMS course.");

  // ---------------------------------------------------------------- reserved and cancelled purchases
  // (The waitlist feature was removed in migration 018: join_waitlist() no longer exists, so nobody is put on a waitlist here.)
  // W1: a listing that is reserved by Aarav's open purchase.
  const w1 = await addListing("vikram", null, { title: "Raspberry Pi 4 kit", description: "4 GB board with case, power supply and SD card.", cond: "GOOD", price: 3500 });
  await purchase(w1, "aarav");

  // W2: Tanvi's purchase is cancelled, so the listing is available again.
  const w2 = await addListing("arjun", null, { title: "Casio fx-991EX scientific calculator", description: "Allowed in exams, works perfectly, includes cover.", cond: "GOOD", price: 650 });
  const w2tx = await purchase(w2, "tanvi");
  await transition(w2tx, "CANCELLED", "STUDENT", S.tanvi.id);

  // ---------------------------------------------------------------- auctions with suspicious bidding
  // Karthik's three auctions: honest first bid, then Rohan bids in rapid bursts in the last minute (HIGH_RISK).
  const karthikAuctions: Array<{ listing: number; honest: string; tx?: number }> = [];
  const karthikBooks: Array<[BookKey, string, string, number]> = [
    ["clrs", "Introduction to Algorithms (CLRS 4th edition)", "ananya", 600],
    ["osc", "Operating System Concepts (Silberschatz, 10th edition)", "diya", 500],
    ["kurose", "Computer Networking: A Top-Down Approach (Kurose and Ross)", "priya", 450],
  ];
  for (let i = 0; i < karthikBooks.length; i++) {
    const [bk, title, honest, startPrice] = karthikBooks[i];
    const end = at(-(3 - i) * DAY);
    const listingId = await addListing("karthik", bk, { title, description: "Auction: starts low, highest bid wins.", cond: "GOOD", price: startPrice, type: "AUCTION" });
    const aId = await addAuction(listingId, new Date(end.getTime() - 2 * DAY), end, 20);
    await bid(aId, honest, startPrice, new Date(end.getTime() - 6 * HOUR));
    await bid(aId, "rohan", startPrice + 100, new Date(end.getTime() - 50 * SEC));
    await bid(aId, "rohan", startPrice + 200, new Date(end.getTime() - 40 * SEC));
    await bid(aId, "rohan", startPrice + 300, new Date(end.getTime() - 30 * SEC));
    const tx = await closeAuction(aId);
    karthikAuctions.push({ listing: listingId, honest, tx });
  }
  await advance(karthikAuctions[0].tx!, "rohan", "karthik", "RELEASED");
  await advance(karthikAuctions[1].tx!, "rohan", "karthik", "HANDED_OFF");
  await rate(karthikAuctions[0].tx!, "rohan", "karthik", 5, "Fast and friendly.");

  // Vikram's two auctions: Ishaan places one last-minute bid in each (SUSPICIOUS).
  const vikramAuctions: Array<[BookKey, string, string, number, number]> = [
    ["aima", "Artificial Intelligence: A Modern Approach (Russell and Norvig)", "ananya", 700, 4 * DAY],
    ["geron", "Hands-On Machine Learning (Geron, 3rd edition)", "tanvi", 600, 36 * HOUR],
  ];
  const vikramTx: number[] = [];
  for (const [bk, title, honest, startPrice, agoMs] of vikramAuctions) {
    const end = at(-agoMs);
    const listingId = await addListing("vikram", bk, { title, description: "Auction listing, pickup at the library.", cond: "LIKE_NEW", price: startPrice, type: "AUCTION" });
    const aId = await addAuction(listingId, new Date(end.getTime() - 2 * DAY), end, 10);
    await bid(aId, honest, startPrice, new Date(end.getTime() - 5 * HOUR));
    await bid(aId, "ishaan", startPrice + 10, new Date(end.getTime() - 40 * SEC));
    vikramTx.push(await closeAuction(aId));
  }
  await advance(vikramTx[0], "ishaan", "vikram", "PAYMENT_HELD");

  // ---------------------------------------------------------------- live auctions
  const al1Listing = await addListing("priya", "strang", { title: "Introduction to Linear Algebra (Strang)", description: "Live auction, ends in two days.", cond: "GOOD", price: 300, type: "AUCTION" });
  const al1 = await addAuction(al1Listing, at(-2 * HOUR), at(2 * DAY), 10);
  await bid(al1, "sneha", 300, at(-90 * MIN));
  await bid(al1, "meera", 320, at(-60 * MIN));
  await bid(al1, "sneha", 340, at(-30 * MIN));

  const al2Listing = await addListing("aarav", "osc", { title: "Operating System Concepts (Silberschatz)", description: "Live auction ending soon: bid in the last minute to see anti-sniping extend it.", cond: "GOOD", price: 480, type: "AUCTION" });
  const al2 = await addAuction(al2Listing, at(-3 * HOUR), at(1 * HOUR), 10);
  await bid(al2, "arjun", 480, at(-2 * HOUR));
  await bid(al2, "diya", 500, at(-45 * MIN));
  await c.query("SELECT tf_notify($1::int, 'AUCTION_ENDING', 'Auction ending soon', 'An auction you bid on ends within the hour.', $2::int)", [S.arjun.id, al2Listing]);
  await c.query("SELECT tf_notify($1::int, 'AUCTION_ENDING', 'Auction ending soon', 'An auction you bid on ends within the hour.', $2::int)", [S.diya.id, al2Listing]);

  // ---------------------------------------------------------------- offers, wishlist, price alerts
  await insert(c, "offer", "offer_id", { listing_id: L2, buyer_id: S.ishaan.id, amount: 800, message: "Can you do 800? I can pick it up today." });
  await insert(c, "offer", "offer_id", { listing_id: L2, buyer_id: S.arjun.id, amount: 780 });

  const wish = (student: string, listing: number) => insert(c, "wishlist", "student_id", { student_id: S[student].id, listing_id: listing });
  for (const s of ["tanvi", "ishaan", "ananya", "vikram", "priya"]) await wish(s, L2);
  for (const s of ["diya", "ishaan", "ananya"]) await wish(s, L1);
  for (const s of ["tanvi", "rohan"]) await wish(s, L11);
  await wish("diya", L13);
  await wish("sneha", swapStrang);
  for (const s of ["ishaan", "priya"]) await wish(s, swapKreyszig);
  await wish("aarav", L10);
  await wish("meera", L9);

  // Alerts first, then a matching listing: the trigger creates the PRICE_ALERT notification.
  await insert(c, "price_alert", "alert_id", { student_id: S.tanvi.id, book_id: book.dl, max_price: 500 });
  await insert(c, "price_alert", "alert_id", { student_id: S.ishaan.id, book_id: book.kreyszig, max_price: 300 });
  await addListing("priya", "dl", { title: "Deep Learning (Goodfellow, Bengio, Courville)", description: "Cheap copy, a few creases on the cover.", cond: "FAIR", price: 450 });

  // ---------------------------------------------------------------- search activity (demand analytics)
  const studentKeys = Object.keys(S);
  const semanticQueries = [
    "third year machine learning textbook",
    "cheap calculus book for first year",
    "database book for dbms semester 5",
    "algorithms reference for placements",
    "easy introduction to linear algebra",
  ];
  const activity: Array<[BookKey, number, number]> = [
    ["geron", 14, course.ml], ["prml", 8, course.ml], ["dl", 7, course.ml], ["aima", 4, course.ml],
    ["kreyszig", 5, course.math], ["clrs", 6, course.dsa], ["dbc", 5, course.dbms], ["strang", 3, course.la],
    ["mano", 2, course.dd], ["osc", 3, course.os], ["kurose", 2, course.cn], ["elm", 2, course.dbms],
  ];
  let n = 0;
  for (const [bk, count, courseId] of activity) {
    for (let i = 0; i < count; i++) {
      const type = i % 3 === 0 ? "VIEW" : i % 3 === 1 ? "FULLTEXT" : "SEMANTIC";
      await insert(c, "search_activity", "search_id", {
        student_id: S[studentKeys[n % studentKeys.length]].id,
        query_text: type === "VIEW" ? "" : type === "SEMANTIC" ? semanticQueries[n % semanticQueries.length] : "textbook",
        search_type: type,
        book_id: book[bk],
        course_id: courseId,
        searched_at: at(-((n * 53) % (20 * 24 * 60)) * MIN),
      });
      n++;
    }
  }

  // ---------------------------------------------------------------- chat
  const conv = async (listing: number, buyer: string, seller: string, lines: Array<[string, string]>) => {
    const id = await insert(c, "conversation", "conversation_id", { listing_id: listing, buyer_id: S[buyer].id, seller_id: S[seller].id });
    for (const [who, body] of lines) {
      await insert(c, "message", "message_id", { conversation_id: id, sender_id: S[who].id, body });
    }
  };
  await conv(L2, "ishaan", "diya", [
    ["ishaan", "Hi, is the Geron book still available?"],
    ["diya", "Yes, it is. I can meet at the library tomorrow."],
    ["ishaan", "Great, I will send an offer."],
  ]);
  await conv(L1, "ananya", "aarav", [
    ["ananya", "Are the notes in the margins readable?"],
    ["aarav", "Only a few, mostly highlighted lines."],
  ]);
  await conv(L13, "diya", "arjun", [["diya", "Does the Elmasri book include the practice problems?"]]);
  await c.query(
    "UPDATE message SET read_at = now() WHERE message_id IN (SELECT message_id FROM message ORDER BY message_id LIMIT 3)"
  );

  // ---------------------------------------------------------------- reports and moderation
  const report = (reporter: string, reason: string, details: string, o: { student?: string; listing?: number }) =>
    insert(c, "report", "report_id", {
      reporter_id: S[reporter].id,
      reported_student_id: o.student ? S[o.student].id : null,
      reported_listing_id: o.listing ?? null,
      reason,
      details,
    });
  await report("ananya", "SUSPICIOUS_BEHAVIOR", "This bidder jumps in with several bids in the last seconds of Karthik's auctions.", { student: "rohan" });
  await report("meera", "WRONG_DESCRIPTION", "The calculator listing says it comes with a cover but the seller replied it does not.", { listing: w2 });
  const dismissed = await report("diya", "SPAM", "Sent the same message to many sellers.", { student: "ishaan" });
  const warned = await report("vikram", "SCAM", "Won two auctions and then went silent.", { student: "rohan" });
  // Pending -> Under review -> Resolved / Dismissed, every step with the admin's reason
  await c.query("SELECT admin_set_report_status($1::int, $2::int, 'UNDER_REVIEW', 'Checking the chat history')", [dismissed, adminId]);
  await c.query("SELECT admin_set_report_status($1::int, $2::int, 'DISMISSED', 'The messages look like normal enquiries')", [dismissed, adminId]);
  await c.query("SELECT admin_set_report_status($1::int, $2::int, 'UNDER_REVIEW', 'Looking at both auctions')", [warned, adminId]);
  await c.query("SELECT admin_take_action($1::int, 'WARN_USER', 'Please complete the payment after winning an auction', $2::int, NULL, NULL, $3::int)", [adminId, S.rohan.id, warned]);
  await c.query("SELECT admin_set_report_status($1::int, $2::int, 'RESOLVED', 'User warned')", [warned, adminId]);

  // some notifications are already read
  await c.query("UPDATE notification SET is_read = true WHERE notification_id % 3 = 0");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local first.");

  const force = process.argv.includes("--force");
  if (force) requireDeleteConfirmation(databaseUrl, process.argv, "npm run db:seed -- --force");

  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const seeded = (await c.query("SELECT 1 FROM student WHERE srn = $1", [MARKER_SRN])).rowCount! > 0;

    if (seeded && !force) {
      console.log("Demo data already exists. Nothing to do. Use `npm run db:seed -- --force --confirm=<database name>` to wipe and re-seed.");
      return;
    }
    if (!force) {
      // The demo accounts (including an admin with a known password) must never be added to a database with real data.
      const used = (await c.query("SELECT (SELECT COUNT(*)::int FROM student) AS students, (SELECT COUNT(*)::int FROM listing) AS listings")).rows[0];
      if (used.students > 0 || used.listings > 0) {
        console.error(`REFUSED: this database already holds ${used.students} student(s) and ${used.listings} listing(s). The seed only runs on an empty database. Nothing was changed.`);
        process.exitCode = 1;
        return;
      }
    }

    await c.query("BEGIN");
    try {
      if (force) {
        const tables = (
          await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")
        ).rows.map((r) => `"${r.tablename}"`);
        if (tables.length > 0) {
          await c.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
          console.log("Existing data removed.");
        }
      }
      await seedAll(c);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }

    const counts = await c.query(`
      SELECT (SELECT COUNT(*) FROM student) AS students,
             (SELECT COUNT(*) FROM listing) AS listings,
             (SELECT COUNT(*) FROM auction) AS auctions,
             (SELECT COUNT(*) FROM bid) AS bids,
             (SELECT COUNT(*) FROM transactions) AS transactions,
             (SELECT COUNT(*) FROM notification) AS notifications,
             (SELECT COUNT(*) FROM v_bid_risk WHERE risk_level <> 'NORMAL') AS flagged_bidders
    `);
    console.log("Seed finished:", counts.rows[0]);
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
