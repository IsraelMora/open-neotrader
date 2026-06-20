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
  'pretest_variant_created',
  'pretest_compared',
  'pretest_cap_reached',
  // F6-S3 debate event types
  'debate_started',
  'debate_stance',
  'debate_consensus',
  'debate_skipped',
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

  // ── F4-S3 Task 1.2 — s3 audit event types compile-guard ─────────────────────

  it('s3 — includes pretest_variant_created as a valid event type (compile-guard)', () => {
    // Compile-time gate: tsc rejects if 'pretest_variant_created' is not in the union.
    const eventType: AuditEventType = 'pretest_variant_created';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('s3 — includes pretest_compared as a valid event type (compile-guard)', () => {
    const eventType: AuditEventType = 'pretest_compared';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('s3 — includes pretest_cap_reached as a valid event type (compile-guard)', () => {
    const eventType: AuditEventType = 'pretest_cap_reached';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  // ── F6-S3 Task A2.1 — debate event types compile-guard ───────────────────────

  it('f6s3 — includes debate_started as a valid event type (compile-guard)', () => {
    const eventType: AuditEventType = 'debate_started';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('f6s3 — includes debate_stance as a valid event type (compile-guard)', () => {
    const eventType: AuditEventType = 'debate_stance';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('f6s3 — includes debate_consensus as a valid event type (compile-guard)', () => {
    const eventType: AuditEventType = 'debate_consensus';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });

  it('f6s3 — includes debate_skipped as a valid event type (compile-guard)', () => {
    const eventType: AuditEventType = 'debate_skipped';
    expect(KNOWN_EVENT_TYPES).toContain(eventType);
  });
});
