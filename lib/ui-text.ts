// Short explanations shown in tooltips (interface text only; the rules themselves live in the database).
export const STATE_TIPS: Record<string, string> = {
  PENDING: "The deal was created. The next step is for the buyer to agree on how and when to pay the seller.",
  PAYMENT_HELD: "The buyer and seller agreed on the payment (no money goes through THRIFTFLIP). Next the item is handed over.",
  HANDED_OFF: "The item was handed over. The buyer now confirms they received it.",
  CONFIRMED: "The buyer confirmed receipt. The seller can now mark the deal complete.",
  RELEASED: "The deal is complete. It can now be rated.",
  CANCELLED: "The deal was cancelled.",
};
