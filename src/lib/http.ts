export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in to continue') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const tooLarge = (message: string) => new ApiError(413, 'too_large', message);

/** A content-disposition value that downloads as `filename`. */
export function attachment(filename: string): string {
  return `attachment; filename="${filename.replaceAll('"', '').replaceAll('\\', '')}"`;
}
