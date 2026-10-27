/** A superseded runtime is cancellation, not evidence that a remote file is missing. */
export class TdSessionSupersededError extends Error {
  constructor() { super("TDLib session superseded"); }
}
