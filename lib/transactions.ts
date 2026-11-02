// Who may move a transaction to which state. The DATABASE decides whether the move itself is valid
// (trigger trg_tx_validate_transition); this table decides which person is allowed to ask for it.
export type TxActor = "buyer" | "seller" | "admin";

export const WHO_CAN_MOVE_TO: Record<string, TxActor[]> = {
  PAYMENT_HELD: ["buyer"],
  HANDED_OFF: ["seller"],
  CONFIRMED: ["buyer"],
  RELEASED: ["seller", "admin"],
  CANCELLED: ["buyer", "seller", "admin"],
};

export const NEXT_STATES: Record<string, string[]> = {
  PENDING: ["PAYMENT_HELD", "CANCELLED"],
  PAYMENT_HELD: ["HANDED_OFF", "CANCELLED"],
  HANDED_OFF: ["CONFIRMED"],
  CONFIRMED: ["RELEASED"],
  RELEASED: [],
  CANCELLED: [],
};

export function actionsFor(state: string, actor: TxActor): string[] {
  return (NEXT_STATES[state] ?? []).filter((s) => WHO_CAN_MOVE_TO[s].includes(actor));
}
