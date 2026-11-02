// Direct swap proposals: which buttons a student may see for a proposal in a given status.
// The DATABASE (respond_swap_proposal / confirm_swap_exchange) re-checks every rule under row locks;
// this only decides what the page offers.
export type SwapAction = "accept" | "reject" | "cancel" | "confirm";

export interface SwapProposalState {
  status: string;
  proposer_id: number;
  receiver_id: number;
  proposer_confirmed_at: string | null;
  receiver_confirmed_at: string | null;
}

export function swapActionsFor(p: SwapProposalState, studentId: number): SwapAction[] {
  const isProposer = p.proposer_id === studentId;
  const isReceiver = p.receiver_id === studentId;
  if (!isProposer && !isReceiver) return [];
  if (p.status === "PENDING") return isReceiver ? ["accept", "reject"] : ["cancel"];
  if (p.status === "ACCEPTED") {
    const confirmed = isProposer ? p.proposer_confirmed_at : p.receiver_confirmed_at;
    return confirmed ? ["cancel"] : ["confirm", "cancel"];
  }
  return [];
}
