/** Actual file bytes shared by the Send and Save draft request contracts. */
export interface ComposeAttachmentPayload {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
}

/** Keep the existing 1 MiB HTTP request ceiling; attachment bytes share it. */
export const COMPOSE_ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 10,
  maxDecodedBytes: 512 * 1024,
  maxRequestBytes: 1024 * 1024,
  maxFilenameBytes: 255,
  maxContentTypeLength: 127,
});
