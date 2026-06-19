import type { AuditEventType } from './audit.service';

// The set of all known audit event types — used to verify membership at runtime.
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
  'skill_written',
  'skill_reverted',
  'skill_write_denied',
  'reflection_turn',
];

describe('AuditEventType', () => {
  it('includes chat_turn as a valid event type', () => {
    // Compile-time gate: tsc will reject this if 'chat_turn' is not in the union.
    const eventType: AuditEventType = 'chat_turn';
    // Runtime gate: verify the literal value is in the known set.
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('includes skill_written as a valid event type', () => {
    // Compile-time gate: tsc will reject this if 'skill_written' is not in the union.
    const eventType: AuditEventType = 'skill_written';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('includes skill_reverted as a valid event type', () => {
    const eventType: AuditEventType = 'skill_reverted';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('includes skill_write_denied as a valid event type', () => {
    const eventType: AuditEventType = 'skill_write_denied';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('includes reflection_turn as a valid event type (s2 compile-guard)', () => {
    // Compile-time gate: tsc will reject this if 'reflection_turn' is not in the union.
    const eventType: AuditEventType = 'reflection_turn';
    // Runtime gate: verify the literal value is in the known set.
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });
});
