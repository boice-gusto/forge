/**
 * Cancellation semantics shared by every sandbox adapter, so that a cancelled
 * lease looks the same whichever backend was underneath it.
 *
 * A cancelled lease **rejects**. A caller that could not tell a cancellation
 * from a result would treat an abandoned run as a finished one; and the
 * adapter's own `finally` still releases the environment underneath, so the
 * abandoned work has nothing left to run in.
 */
export function assertNotCancelled(signal: AbortSignal | undefined): void {
  // Checked before anything is provisioned: a lease cancelled before it starts
  // must not leave a container behind for a sweeper to find later.
  if (signal?.aborted === true) throw cancelled();
}

export async function raceCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) throw cancelled();

  let onAbort = (): void => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cancelled(): Error {
  return new Error("The sandbox lease was cancelled before the work finished.");
}

/** The refusal a profile outside an adapter's catalogue must produce. */
export function unsupportedProfile(
  profile: string,
  supported: readonly string[],
): Error {
  return new Error(
    `Sandbox profile '${profile}' is not one this adapter provisions ` +
      `(${supported.join(", ")}). Substituting another profile would give the ` +
      "step less isolation than it declared.",
  );
}
