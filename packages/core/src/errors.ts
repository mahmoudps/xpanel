export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'CONFLICT'
  | 'LIMIT_EXCEEDED'
  | 'OVERSELL_BLOCKED'
  | 'SELF_LOCKOUT'
  | 'ENGINE_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'UNSUPPORTED_OS'
  | 'CONFIG_TEST_FAILED'
  | 'PRECONDITION_FAILED'

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 422,
  OVERSELL_BLOCKED: 422,
  SELF_LOCKOUT: 422,
  ENGINE_UNAVAILABLE: 409,
  SERVICE_UNAVAILABLE: 503,
  UNSUPPORTED_OS: 409,
  CONFIG_TEST_FAILED: 500,
  PRECONDITION_FAILED: 412,
}

export class XpanelError extends Error {
  readonly code: ErrorCode
  readonly detail: Record<string, unknown>

  constructor(code: ErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'XpanelError'
    this.code = code
    this.detail = detail
  }

  get status(): number {
    return HTTP_STATUS[this.code]
  }
}

export const fail = (code: ErrorCode, message: string, detail?: Record<string, unknown>): never => {
  throw new XpanelError(code, message, detail)
}

export const isXpanelError = (e: unknown): e is XpanelError => e instanceof XpanelError
