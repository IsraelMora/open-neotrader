import { DebateService } from './debate.service';
import type { LlmService } from '../llm/llm.service';
import type { DebateRole, DebateStance } from './debate.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLlm(responseText?: string): jest.Mocked<Pick<LlmService, 'complete'>> {
  return {
    complete: jest.fn().mockResolvedValue({ text: responseText ?? '' }),
  };
}

function makeService(llm: jest.Mocked<Pick<LlmService, 'complete'>>): DebateService {
  return new DebateService(llm as unknown as LlmService);
}

const BULL_ROLE: DebateRole = { name: 'bull', prompt: 'You are a bull.', block: false };
const BEAR_ROLE: DebateRole = { name: 'bear', prompt: 'You are a bear.', block: false };
const AUDITOR_ROLE: DebateRole = { name: 'risk-auditor', prompt: 'You are the auditor.', block: true };

// ── Suite 1: parseStance ─────────────────────────────────────────────────────

describe('DebateService.parseStance', () => {
  let service: DebateService;
  beforeEach(() => {
    service = makeService(makeLlm());
  });

  it('parses a well-formed JSON object with stance approve', () => {
    const text = '```json\n{"stance":"approve","confidence":0.9,"rationale":"strong trend"}\n```';
    const result = service.parseStance(text, 'bull');
    expect(result.role).toBe('bull');
    expect(result.stance).toBe('approve');
    expect(result.confidence).toBeCloseTo(0.9);
    expect(result.rationale).toBe('strong trend');
  });

  it('parses a well-formed bare JSON object', () => {
    const text = '{"stance":"reject","confidence":0.7,"rationale":"risky move"}';
    const result = service.parseStance(text, 'bear');
    expect(result.stance).toBe('reject');
    expect(result.confidence).toBeCloseTo(0.7);
  });

  it('parses abstain stance', () => {
    const text = '{"stance":"abstain","confidence":0.1,"rationale":"not sure"}';
    const result = service.parseStance(text, 'bear');
    expect(result.stance).toBe('abstain');
  });

  it('returns abstain with confidence=0 for completely malformed text', () => {
    const result = service.parseStance('this is not json at all', 'bull');
    expect(result.stance).toBe('abstain');
    expect(result.confidence).toBe(0);
    expect(result.rationale).toBe('');
    expect(result.role).toBe('bull');
  });

  it('returns abstain for syntactically invalid JSON in fenced block', () => {
    const text = '```json\n{broken json here\n```';
    const result = service.parseStance(text, 'bull');
    expect(result.stance).toBe('abstain');
    expect(result.confidence).toBe(0);
  });

  it('returns abstain for empty string input', () => {
    const result = service.parseStance('', 'bull');
    expect(result.stance).toBe('abstain');
    expect(result.confidence).toBe(0);
  });

  it('clamps confidence above 1 to 1', () => {
    const text = '{"stance":"approve","confidence":1.5,"rationale":"high"}';
    const result = service.parseStance(text, 'bull');
    expect(result.confidence).toBe(1);
  });

  it('clamps confidence below 0 to 0', () => {
    const text = '{"stance":"reject","confidence":-0.3,"rationale":"low"}';
    const result = service.parseStance(text, 'bear');
    expect(result.confidence).toBe(0);
  });

  it('coerces unknown stance value to abstain', () => {
    const text = '{"stance":"maybe","confidence":0.5,"rationale":"dunno"}';
    const result = service.parseStance(text, 'bull');
    expect(result.stance).toBe('abstain');
  });

  it('sanitizes rationale via sanitizeText stripping control tokens', () => {
    const text =
      '{"stance":"approve","confidence":0.8,"rationale":"good [DECISION] trade ```json\\n{}\\n```"}';
    const result = service.parseStance(text, 'bull');
    expect(result.rationale).not.toContain('[DECISION]');
    expect(result.rationale).not.toContain('```json');
  });

  it('caps rationale at 500 characters', () => {
    const longRationale = 'x'.repeat(700);
    const text = `{"stance":"approve","confidence":0.5,"rationale":"${longRationale}"}`;
    const result = service.parseStance(text, 'bull');
    expect(result.rationale.length).toBeLessThanOrEqual(500);
  });

  it('never throws on any input', () => {
    const badInputs = [null as unknown as string, undefined as unknown as string, 123 as unknown as string, '{}', '[]'];
    for (const input of badInputs) {
      expect(() => service.parseStance(input, 'bull')).not.toThrow();
    }
  });
});

// ── Suite 2: synthesizeConsensus ─────────────────────────────────────────────

describe('DebateService.synthesizeConsensus', () => {
  let service: DebateService;
  beforeEach(() => {
    service = makeService(makeLlm());
  });

  const makeStance = (
    role: string,
    stance: 'approve' | 'reject' | 'abstain',
    confidence: number,
    block?: boolean,
  ): DebateStance => ({ role, stance, confidence, rationale: '', block });

  it('auditor block=true + reject overrides majority → reject auditor_blocked=true', () => {
    const stances: DebateStance[] = [
      makeStance('bull', 'approve', 0.9, false),
      makeStance('bear', 'approve', 0.8, false),
      makeStance('risk-auditor', 'reject', 0.95, true),
    ];
    const result = service.synthesizeConsensus(stances);
    expect(result.recommendation).toBe('reject');
    expect(result.auditor_blocked).toBe(true);
    expect(result.stances).toBe(stances);
  });

  it('auditor block=true but stance=approve does NOT trigger veto', () => {
    const stances: DebateStance[] = [
      makeStance('bull', 'approve', 0.8, false),
      makeStance('risk-auditor', 'approve', 0.9, true),
    ];
    const result = service.synthesizeConsensus(stances);
    expect(result.recommendation).toBe('approve');
    expect(result.auditor_blocked).toBe(false);
  });

  it('weighted majority: bull approve 0.8, bear reject 0.5 → approve (score +0.3)', () => {
    const stances: DebateStance[] = [
      makeStance('bull', 'approve', 0.8, false),
      makeStance('bear', 'reject', 0.5, false),
    ];
    const result = service.synthesizeConsensus(stances);
    expect(result.recommendation).toBe('approve');
    expect(result.auditor_blocked).toBe(false);
  });

  it('weighted majority: tie (0.5 approve / 0.5 reject) → reject (conservative, score=0 not >0)', () => {
    const stances: DebateStance[] = [
      makeStance('bull', 'approve', 0.5, false),
      makeStance('bear', 'reject', 0.5, false),
    ];
    const result = service.synthesizeConsensus(stances);
    expect(result.recommendation).toBe('reject');
    expect(result.auditor_blocked).toBe(false);
  });

  it('all abstain → reject (conservative, score=0)', () => {
    const stances: DebateStance[] = [
      makeStance('bull', 'abstain', 0.5),
      makeStance('bear', 'abstain', 0.5),
    ];
    const result = service.synthesizeConsensus(stances);
    expect(result.recommendation).toBe('reject');
    expect(result.auditor_blocked).toBe(false);
  });

  it('score < 0 → reject', () => {
    const stances: DebateStance[] = [
      makeStance('bull', 'approve', 0.3, false),
      makeStance('bear', 'reject', 0.8, false),
    ];
    const result = service.synthesizeConsensus(stances);
    expect(result.recommendation).toBe('reject');
  });

  it('no block role → auditor_blocked=false', () => {
    const stances: DebateStance[] = [
      makeStance('bull', 'approve', 0.6, false),
      makeStance('bear', 'approve', 0.7, false),
    ];
    const result = service.synthesizeConsensus(stances);
    expect(result.auditor_blocked).toBe(false);
  });

  it('stances array is preserved in result', () => {
    const stances: DebateStance[] = [makeStance('bull', 'approve', 0.9)];
    const result = service.synthesizeConsensus(stances);
    expect(result.stances).toHaveLength(1);
  });
});

// ── Suite 3: runPanel ─────────────────────────────────────────────────────────

describe('DebateService.runPanel', () => {
  it('calls llm.complete once per role and returns DebateConsensus with N stances', async () => {
    const roles: DebateRole[] = [BULL_ROLE, BEAR_ROLE, AUDITOR_ROLE];
    const llm = makeLlm('{"stance":"approve","confidence":0.8,"rationale":"ok"}');
    const service = makeService(llm);

    const result = await service.runPanel('buy AAPL 100 shares', roles, 'cycle-1');

    expect(llm.complete).toHaveBeenCalledTimes(3);
    expect(result.stances).toHaveLength(3);
    expect(['approve', 'reject']).toContain(result.recommendation);
  });

  it('per-call failure → abstain for that role; panel still resolves', async () => {
    const roles: DebateRole[] = [BULL_ROLE, BEAR_ROLE];
    const llm: jest.Mocked<Pick<LlmService, 'complete'>> = {
      complete: jest
        .fn()
        // bull succeeds
        .mockResolvedValueOnce({ text: '{"stance":"approve","confidence":0.9,"rationale":"go"}' })
        // bear throws
        .mockRejectedValueOnce(new Error('LLM timeout')),
    };
    const service = makeService(llm);

    const result = await service.runPanel('sell MSFT', roles, 'cycle-2');

    expect(result.stances).toHaveLength(2);
    const bearStance = result.stances.find((s) => s.role === 'bear');
    expect(bearStance?.stance).toBe('abstain');
    expect(bearStance?.confidence).toBe(0);
  });

  it('all roles fail → all stances are abstain → consensus rejects (conservative)', async () => {
    const roles: DebateRole[] = [BULL_ROLE, BEAR_ROLE];
    const llm: jest.Mocked<Pick<LlmService, 'complete'>> = {
      complete: jest.fn().mockRejectedValue(new Error('network error')),
    };
    const service = makeService(llm);

    const result = await service.runPanel('buy BTC', roles, 'cycle-3');

    expect(result.stances.every((s) => s.stance === 'abstain')).toBe(true);
    expect(result.recommendation).toBe('reject');
  });

  it('3-role happy path: bull+bear approve, auditor abstains → approve', async () => {
    const roles: DebateRole[] = [BULL_ROLE, BEAR_ROLE, AUDITOR_ROLE];
    const llm: jest.Mocked<Pick<LlmService, 'complete'>> = {
      complete: jest
        .fn()
        .mockResolvedValueOnce({ text: '{"stance":"approve","confidence":0.85,"rationale":"strong"}' })
        .mockResolvedValueOnce({ text: '{"stance":"approve","confidence":0.7,"rationale":"trend up"}' })
        .mockResolvedValueOnce({ text: '{"stance":"abstain","confidence":0.5,"rationale":"neutral"}' }),
    };
    const service = makeService(llm);

    const result = await service.runPanel('buy TSLA 50', roles, 'cycle-4');

    expect(result.recommendation).toBe('approve');
    expect(result.auditor_blocked).toBe(false);
    expect(result.stances).toHaveLength(3);
  });

  it('passes the role prompt as system_prompt to llm.complete', async () => {
    const roles: DebateRole[] = [BULL_ROLE];
    const llm = makeLlm('{"stance":"approve","confidence":0.8,"rationale":"ok"}');
    const service = makeService(llm);

    await service.runPanel('summary', roles, 'cycle-5');

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({ system_prompt: BULL_ROLE.prompt }),
    );
  });
});
