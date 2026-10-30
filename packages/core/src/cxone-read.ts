// Provenance belongs to the actual SDK call, never a caller-supplied property,
// upstream message, or HTTP status observed at the public request boundary.
const authenticationFailures = new WeakSet<object>();

export async function cxoneRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error !== null && typeof error === 'object' &&
        ((error as {status?:unknown}).status === 401 || (error as {status?:unknown}).status === 403)) {
      authenticationFailures.add(error);
    }
    throw error; // Preserve the SDK's existing error/status/body for callers.
  }
}

export function isCxoneReadAuthFailure(error: unknown): boolean {
  return error !== null && typeof error === 'object' && authenticationFailures.has(error);
}
