export class AuthorityCutoverError extends Error {
  override readonly name = 'AuthorityCutoverError';

  constructor(
    readonly code: string,
    readonly details: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
