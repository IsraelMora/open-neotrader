import {
  normalizeBrokerStatus,
  isTerminalStatus,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
} from './broker-status.util';

describe('normalizeBrokerStatus', () => {
  it.each([
    ['new', 'accepted'],
    ['pending_new', 'accepted'],
    ['accepted', 'accepted'],
    ['accepted_for_bidding', 'accepted'],
    ['pending_replace', 'accepted'],
    ['replaced', 'accepted'],
    ['held', 'accepted'],
    ['suspended', 'accepted'],
    ['partially_filled', 'partially_filled'],
    ['filled', 'filled'],
    ['canceled', 'canceled'],
    ['pending_cancel', 'canceled'],
    ['rejected', 'rejected'],
    ['expired', 'expired'],
    ['done_for_day', 'expired'],
  ])('maps raw status %s -> canonical %s', (raw, expected) => {
    expect(normalizeBrokerStatus(raw)).toBe(expected);
  });

  it('fails open to "accepted" (pollable) for an unrecognized status, never dropping the order', () => {
    expect(normalizeBrokerStatus('some_future_alpaca_status')).toBe('accepted');
  });

  it('every OPEN_STATUSES/TERMINAL_STATUSES entry is disjoint and covers the canonical vocabulary', () => {
    const overlap = OPEN_STATUSES.filter((s) =>
      (TERMINAL_STATUSES as readonly string[]).includes(s),
    );
    expect(overlap).toHaveLength(0);
  });
});

describe('isTerminalStatus', () => {
  it('returns true for filled/canceled/rejected/expired', () => {
    expect(isTerminalStatus('filled')).toBe(true);
    expect(isTerminalStatus('canceled')).toBe(true);
    expect(isTerminalStatus('rejected')).toBe(true);
    expect(isTerminalStatus('expired')).toBe(true);
  });

  it('returns false for accepted/partially_filled/pending_submit/submit_failed', () => {
    expect(isTerminalStatus('accepted')).toBe(false);
    expect(isTerminalStatus('partially_filled')).toBe(false);
    expect(isTerminalStatus('pending_submit')).toBe(false);
    expect(isTerminalStatus('submit_failed')).toBe(false);
  });
});
