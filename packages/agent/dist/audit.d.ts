import type { AuditEvent, AuditLogger } from "./types";
export type { AuditEvent, AuditEventType, AuditLogger } from "./types";
export declare class ConsoleAuditLogger implements AuditLogger {
    log(event: AuditEvent): void;
}
//# sourceMappingURL=audit.d.ts.map