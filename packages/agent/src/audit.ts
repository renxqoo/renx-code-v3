import type { AuditEvent, AuditEventType, AuditLogger } from "./types";
export type { AuditEvent, AuditEventType, AuditLogger } from "./types";

export class ConsoleAuditLogger implements AuditLogger {
  log(event: AuditEvent): void {
    console.log(`[Audit:${event.type}] run=${event.runId}`, event.payload);
  }
}
