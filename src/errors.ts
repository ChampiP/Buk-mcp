export class BukServiceError extends Error {
  constructor(message: string, readonly code = 'BUK_REQUEST_FAILED') {
    super(message);
    this.name = 'BukServiceError';
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof BukServiceError) return error.message;
  return 'BUK request could not be completed. Check configuration and retry later.';
}
