/** A timeout/IPC failure says nothing about whether TDLib accepted a send. */
export class TdRequestError extends Error {
  constructor(message: string, readonly outcome: "rejected" | "unknown", readonly code?: number) {
    super(message);
  }
}

/** Only the sending adapter can establish that replay will not duplicate a send. */
export class RetryableSendError extends Error {
  constructor(error: Error, readonly retryAfterMs: number) {
    super(error.message, { cause: error });
  }
}

export const classifySendError = (error: unknown, beforeSubmission = false): unknown => {
  if (!(error instanceof TdRequestError)) return error;
  if (error.outcome === "unknown" && !beforeSubmission) return error;
  if (error.code === 429) {
    const seconds = Number(/(?:retry after |FLOOD_WAIT_)(\d+)/i.exec(error.message)?.[1] ?? 30);
    return new RetryableSendError(error, Math.max(1, seconds) * 1_000);
  }
  if (error.code !== undefined && error.code >= 500 && error.code < 600 ||
    beforeSubmission && error.outcome === "unknown") {
    return new RetryableSendError(error, 5_000);
  }
  return error;
};
