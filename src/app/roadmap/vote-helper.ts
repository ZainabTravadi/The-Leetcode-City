export async function performVoteWithRollback(opts: {
  setOptimistic: (action: "toggle") => void;
  toggleVoteFn: (itemId: string) => Promise<unknown>;
  itemId: string;
}) {
  const { setOptimistic, toggleVoteFn, itemId } = opts;
  setOptimistic("toggle");
  try {
    await toggleVoteFn(itemId);
  } catch (err) {
    setOptimistic("toggle");
    throw err;
  }
}
export async function performVoteWithRollback(opts: {
  setOptimistic: (action: "toggle") => void;
  toggleVoteFn: (itemId: string) => Promise<unknown>;
  itemId: string;
}) {
  const { setOptimistic, toggleVoteFn, itemId } = opts;
  setOptimistic("toggle");
  try {
    await toggleVoteFn(itemId);
  } catch (err) {
    // rollback optimistic change
    setOptimistic("toggle");
    // Re-throw so callers can handle or surface the error (do not silently swallow)
    throw err;
  }
}
