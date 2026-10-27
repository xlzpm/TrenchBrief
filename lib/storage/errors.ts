export class BriefStoreError extends Error {
  readonly code: "invalid" | "corrupt" | "unavailable";

  constructor(
    code: BriefStoreError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BriefStoreError";
    this.code = code;
  }
}
