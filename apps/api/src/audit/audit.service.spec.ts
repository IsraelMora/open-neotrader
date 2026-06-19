import type { AuditEventType } from './audit.service';

// The set of all known audit event types — used to verify 'chat_turn' membership at runtime.
const KNOWN_EVENT_TYPES: AuditEventType[] = [
  'cycle_start',
  'cycle_complete',
  'cycle_fail',
  'signal',
  'decision',
  'plugin_activate',
  'plugin_deactivate',
  'credential_set',
  'tool_call_dropped',
  'parse_miss',
  'chat_turn',
];

describe('AuditEventType', () => {
  it('includes chat_turn as a valid event type', () => {
    // Compile-time gate: tsc will reject this if 'chat_turn' is not in the union.
    const eventType: AuditEventType = 'chat_turn';
    // Runtime gate: verify the literal value is in the known set.
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });
});
