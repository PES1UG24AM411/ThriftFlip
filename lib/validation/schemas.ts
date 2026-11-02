// Zod schemas: server-side validation of every request body. The database re-checks the same
// rules with CHECK constraints, triggers and functions.
import { z } from "zod";
import { EMAIL_PATTERN, REG_MSG, SRN_PATTERN } from "./registration";

const id = z.coerce.number().int().positive();
const condition = z.enum(["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"]);

// Books a seller would take in exchange (listing is open to swap): a catalogue book or a typed title. At most 5.
const wantedBookSchema = z.union([z.object({ bookId: id }), z.object({ title: z.string().trim().min(2).max(150) })]);
export const wantedBooksSchema = z.array(wantedBookSchema).max(5, "You can list at most 5 wanted books");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72)
  .regex(/[A-Za-z]/, "Password needs a letter")
  .regex(/[0-9]/, "Password needs a digit");

// B.Tech only: the programme is fixed by the database (CHECK), semesters 1 to 8.
// Messages and patterns come from ./registration so the browser form shows exactly the same rules.
const required = { required_error: REG_MSG.missing, invalid_type_error: REG_MSG.missing };
export const registerSchema = z.object({
  srn: z.string(required).trim().toUpperCase().min(1, REG_MSG.missing).regex(SRN_PATTERN, REG_MSG.invalidSrn),
  name: z.string(required).trim().min(1, REG_MSG.missing).min(2, REG_MSG.invalidName).max(100, REG_MSG.invalidName),
  email: z.string(required).trim().toLowerCase().min(1, REG_MSG.missing).regex(EMAIL_PATTERN, REG_MSG.invalidEmail).max(200, REG_MSG.invalidEmail),
  password: z
    .string(required)
    .min(1, REG_MSG.missing)
    .min(8, REG_MSG.weakPassword)
    .max(72, REG_MSG.weakPassword)
    .regex(/[A-Za-z]/, REG_MSG.weakPassword)
    .regex(/[0-9]/, REG_MSG.weakPassword),
  departmentId: z.coerce.number(required).int(REG_MSG.missing).positive(REG_MSG.missing),
  semester: z.coerce.number(required).int(REG_MSG.invalidSemester).min(1, REG_MSG.invalidSemester).max(8, REG_MSG.invalidSemester),
});

export const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetSchema = z.object({ token: z.string().trim().min(20).max(200), password: passwordSchema });

export const profileUpdateSchema = z.object({
  semester: z.coerce.number().int().min(1).max(8).optional(),
  departmentId: id.optional(),
  contactPreference: z.enum(["IN_APP", "EMAIL", "PHONE"]).optional(),
  phone: z.string().trim().regex(/^\+?[0-9]{10,13}$/, "Phone must have 10 to 13 digits").nullable().optional(),
  showContact: z.boolean().optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
  role: z.enum(["STUDENT", "ADMIN"]).default("STUDENT"),
});

// A textbook listing carries the book details typed by the seller (or an existing bookId).
export const listingCreateSchema = z
  .object({
    category: z.enum(["TEXTBOOK", "GOODS"]).default("TEXTBOOK"),
    bookId: id.nullish(),
    title: z.string().trim().min(3).max(150),
    author: z.string().trim().max(150).optional(),
    edition: z.coerce.number().int().min(1).max(50).default(1),
    isbn: z
      .string()
      .trim()
      .transform((v) => v.replace(/[-\s]/g, "").toUpperCase())
      .pipe(z.string().regex(/^([0-9]{9}[0-9X]|[0-9]{13})$/, "ISBN must have 10 or 13 digits"))
      .optional()
      .or(z.literal("").transform(() => undefined)),
    courseId: id.nullish(),
    description: z.string().trim().max(2000).default(""),
    condition,
    listingType: z.enum(["FIXED_PRICE", "AUCTION"]).default("FIXED_PRICE"),
    price: z.coerce.number().positive().max(100000),
    openToSwap: z.boolean().default(false),
    wantedBooks: wantedBooksSchema.optional(),
    durationHours: z.coerce.number().int().min(1).max(168).default(48),
    minIncrement: z.coerce.number().positive().max(10000).default(10),
  })
  .refine((v) => v.category === "GOODS" || v.bookId || v.author, { message: "Author is required for a textbook", path: ["author"] });

export const listingUpdateSchema = z.object({
  title: z.string().trim().min(3).max(150).optional(),
  description: z.string().trim().max(2000).optional(),
  condition: condition.optional(),
  price: z.coerce.number().positive().max(100000).optional(),
  openToSwap: z.boolean().optional(),
  wantedBooks: wantedBooksSchema.optional(),
});

export const bidSchema = z.object({ auctionId: id, amount: z.coerce.number().positive().max(100000) });
export const offerCreateSchema = z.object({
  listingId: id,
  amount: z.coerce.number().positive().max(100000),
  message: z.string().trim().max(500).optional(),
});
export const offerActionSchema = z.object({ action: z.enum(["accept", "reject", "withdraw"]) });
export const purchaseSchema = z.object({ listingId: id });
export const transitionSchema = z.object({
  state: z.enum(["PAYMENT_HELD", "HANDED_OFF", "CONFIRMED", "RELEASED", "CANCELLED"]),
});
export const listingRefSchema = z.object({ listingId: id });
export const swapPreferenceSchema = z.object({ offeredListingId: id, wantedBookId: id });
export const swapProposeSchema = z.object({ listingIds: z.array(id).min(2).max(6) });
export const swapProposalSchema = z
  .object({
    offeredListingId: id,
    requestedListingId: id,
    settlementAmount: z.coerce.number().min(0).max(100000).optional().default(0),
    settlementPayer: z.enum(["PROPOSER", "RECEIVER"]).optional(),
    message: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.offeredListingId !== v.requestedListingId, { message: "Choose a different book to offer", path: ["offeredListingId"] })
  .refine((v) => v.settlementAmount === 0 || !!v.settlementPayer, { message: "Say who pays the settlement amount", path: ["settlementPayer"] });
export const swapProposalActionSchema = z.object({ action: z.enum(["accept", "reject", "cancel", "confirm"]) });
export const swapRespondSchema = z.object({ accept: z.boolean() });
// condition (optional): the worst condition the student accepts, e.g. GOOD also notifies for LIKE_NEW and NEW copies. Omitted = any.
export const alertCreateSchema = z.object({ bookId: id, maxPrice: z.coerce.number().positive().max(100000), condition: condition.nullish() });
export const notificationReadSchema = z.object({ id: id.optional() });
// A swap chat is opened from a proposal; a normal chat from a listing.
export const conversationCreateSchema = z.object({ listingId: id.optional(), swapProposalId: id.optional() }).refine((v) => v.listingId || v.swapProposalId, "listingId or swapProposalId is required");
export const messageSchema = z.object({ body: z.string().trim().min(1).max(2000) });
export const ratingSchema = z.object({
  transactionId: id,
  score: z.coerce.number().int().min(1).max(5),
  review: z.string().trim().max(1000).optional(),
});
export const reportSchema = z
  .object({
    listingId: id.optional(),
    studentId: id.optional(),
    reason: z.enum(["FAKE_LISTING", "WRONG_DESCRIPTION", "SCAM", "SPAM", "SUSPICIOUS_BEHAVIOR"]),
    details: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.listingId || v.studentId, { message: "Report a listing or a student" });
export const noticeReplySchema = z.object({ body: z.string().trim().min(1).max(2000), reportId: id.optional(), listingId: id.optional() });

// Admin moderation actions. The database function validates the selected target.
export const adminActionSchema = z.object({
  action: z.enum([
    "WARN_USER",
    "SUSPEND_USER",
    "REACTIVATE_USER",
    "REMOVE_LISTING",
    "RESTORE_LISTING",
    "HIDE_REVIEW",
    "RESTORE_REVIEW",
  ]),
  reason: z.string().trim().min(3).max(1000),
  studentId: id.optional(),
  listingId: id.optional(),
  reviewId: id.optional(),
  reportId: id.optional(),
});

// Official admin messages to students.
export const adminMessageSchema = z.object({
  studentId: id,
  body: z.string().trim().min(1).max(2000),
  kind: z.enum(["MESSAGE", "CLARIFICATION", "WARNING"]).default("MESSAGE"),
  reportId: id.optional(),
  listingId: id.optional(),
});

// Report status transitions. The database enforces the transition order.
export const adminReportStatusSchema = z.object({
  status: z.enum(["UNDER_REVIEW", "RESOLVED", "DISMISSED"]),
  reason: z.string().trim().min(3).max(1000),
});
