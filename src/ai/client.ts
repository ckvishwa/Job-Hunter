import { aiErrorSchema, extractResponseSchema, type ExtractResponse } from "./contracts.js";

export type AiFailureCode =
  | "AI_UNAVAILABLE"
  | "AI_TIMEOUT"
  | "AI_UNAUTHORIZED"
  | "AI_SCHEMA_INVALID"
  // Typed document errors returned by the service:
  | "UNREADABLE_FILE" | "ENCRYPTED_PDF" | "TOO_MANY_PAGES" | "NO_TEXT_LAYER" | "UNSAFE_DOCX" | "NO_DOCX_BODY"
  | "UNSUPPORTED_FILE_TYPE" | "FILE_TOO_LARGE" | "INTERNAL_ERROR" | "EXTRACTOR_UNAVAILABLE";

/** Transient conditions are worth retrying on a re-upload; document defects are not. */
const RETRYABLE: ReadonlySet<string> = new Set(["AI_UNAVAILABLE", "AI_TIMEOUT", "INTERNAL_ERROR", "EXTRACTOR_UNAVAILABLE"]);

export class AiServiceError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: AiFailureCode | string, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "AiServiceError";
    this.retryable = RETRYABLE.has(code);
  }
}

export interface AiClient {
  extractResume(bytes: Uint8Array, fileType: "pdf" | "docx"): Promise<ExtractResponse>;
}

export interface AiClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createAiClient(options: AiClientOptions): AiClient {
  const url = new URL(options.baseUrl);
  if (url.protocol !== "http:" || url.username || url.password || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The AI service endpoint must be credential-free loopback HTTP.");
  }
  if (options.serviceToken.length < 32) throw new Error("AI service token must be at least 32 characters.");
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async extractResume(bytes, fileType) {
      // Extraction is a pure function of the bytes, so a failed CONNECTION (nothing was processed) is safe to retry a couple of
      // times. A timeout after the request was sent is not retried.
      let response: Response | undefined;
      for (let attempt = 0; response === undefined; attempt += 1) {
        try {
          response = await doFetch(`${url.origin}/internal/v1/ai/extract-resume?fileType=${fileType}`, {
            method: "POST",
            headers: { authorization: `Bearer ${options.serviceToken}`, "content-type": "application/octet-stream" },
            body: bytes as unknown as BodyInit,
            signal: AbortSignal.timeout(options.timeoutMs),
          });
        } catch (error) {
          const name = error instanceof Error ? error.name : "";
          if (name === "TimeoutError" || name === "AbortError") throw new AiServiceError("AI_TIMEOUT", "The AI service timed out.");
          if (attempt >= 2) throw new AiServiceError("AI_UNAVAILABLE", "The AI service could not be reached.");
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AiServiceError("AI_SCHEMA_INVALID", "The AI service returned a non-JSON response.", response.status);
      }
      if (!response.ok) {
        const parsed = aiErrorSchema.safeParse(payload);
        if (response.status === 401) throw new AiServiceError("AI_UNAUTHORIZED", "The AI service rejected the service token.", 401);
        if (parsed.success) throw new AiServiceError(parsed.data.error.code, parsed.data.error.message, response.status);
        throw new AiServiceError("AI_SCHEMA_INVALID", "The AI service returned an unrecognized error.", response.status);
      }
      const parsed = extractResponseSchema.safeParse(payload);
      if (!parsed.success) throw new AiServiceError("AI_SCHEMA_INVALID", "The AI service response did not match the v1 contract.", response.status);
      return parsed.data;
    },
  };
}
