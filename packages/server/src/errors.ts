export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what: string, id: string) => new ApiError(404, "not_found", `${what} "${id}" not found`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const badRequest = (message: string, code = "bad_request") => new ApiError(400, code, message);
