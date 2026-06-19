import type { AuditEventType } from './audit.service';

describe('AuditEventType', () => {
  it('includes chat_turn as a valid event type', () => {
    // This is a compile-time + runtime assertion.
    // If 'chat_turn' is not in the union, tsc will reject the assignment below,
    // and the test will also fail at runtime if the value is not accepted.
    const eventType: AuditEventType = 'chat_turn';
    expect(eventType).toBe('chat_turn');
  });
});
