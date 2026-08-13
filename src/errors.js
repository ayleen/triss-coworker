// Typed errors with stable machine-readable codes so callers can branch on
// the failure mode without scraping message text.

/**
 * Thrown when a model call completes but yields no answer text. Throwing lets
 * the error propagate through the normal CLI error path, which flushes
 * diagnostics before the process exits even when stderr is piped.
 */
export class EmptyModelResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmptyModelResponseError';
    this.code = 'TRISS_EMPTY_MODEL_RESPONSE';
  }
}
