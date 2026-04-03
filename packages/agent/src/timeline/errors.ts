export class TimelineVersionConflictError extends Error {
  constructor(message = "Timeline version conflict") {
    super(message);
    this.name = "TimelineVersionConflictError";
  }
}
