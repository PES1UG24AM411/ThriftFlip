// Error carrying an HTTP status; kept in its own file so non-Next code (and tests) can import it.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
