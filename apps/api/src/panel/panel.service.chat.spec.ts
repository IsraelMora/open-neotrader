import type { AgentsService, GovernedTurnResult } from '../agents/agents.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { LlmService } from '../llm/llm.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';
import type { PluginsService } from '../plugins/plugins.service';
import type { PluginEventsService } from '../plugins/plugin-events.service';
import type { AuditService } from '../audit/audit.service';
import type { CycleExecutorService } from '../cycle/cycle-executor.service';
import type { ProviderGatewayService } from '../providers/provider-gateway.service';
import { PanelService } from './panel.service';

// ── Stubs ─────────────────────────────────────────────────────────────────────

const GOVERNED_RESULT: GovernedTurnResult = {
  cycle_id: 'chat-test-cycle',
  text: 'reply',
  tool_calls: [],
  decisions: [],
  sandbox_results: [],
  backend: 'api',
  skills_read: [],
  skills_written: [],
  llm_response: {
    text: 'reply',
    tool_calls: [],
    backend: 'api',
    skills_read: [],
    skills_written: [],
  },
  signalsEmitted: [],
  turns_used: 1,
};

function makeAgents(): jest.Mocked<Pick<AgentsService, 'runGovernedTurn'>> {
  return {
    runGovernedTurn: jest.fn().mockResolvedValue(GOVERNED_RESULT),
  };
}

function makeCycleExecutorStub(): Pick<CycleExecutorService, 'getRunStatus'> {
  return { getRunStatus: jest.fn().mockReturnValue({ running: false, last: null }) };
}

function makePanelService(
  agents: jest.Mocked<Pick<AgentsService, 'runGovernedTurn'>>,
): PanelService {
  return new PanelService(
    {} as unknown as PrismaService,
    agents as unknown as AgentsService,
    {} as unknown as LlmService,
    {} as unknown as SandboxGateway,
    {} as unknown as PluginsService,
    {} as unknown as PluginEventsService,
    {} as unknown as AuditService,
    makeCycleExecutorStub() as unknown as CycleExecutorService,
    {} as unknown as ProviderGatewayService,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PanelService.chat — routes through AgentsService.runGovernedTurn', () => {
  it('calls runGovernedTurn with context built from question (no history); returns {response, tool_calls, backend}', async () => {
    const agents = makeAgents();
    const service = makePanelService(agents);

    const result = await service.chat('hello');

    expect(agents.runGovernedTurn).toHaveBeenCalledTimes(1);
    expect(agents.runGovernedTurn).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'hello' }),
    );

    expect(result).toEqual({
      response: 'reply',
      tool_calls: [],
      backend: 'api',
    });
  });

  it('builds context from history + question when history is provided', async () => {
    const agents = makeAgents();
    const service = makePanelService(agents);

    const history = [{ role: 'user', content: 'previous message' }];
    await service.chat('follow-up', history);

    const firstArg = agents.runGovernedTurn.mock.calls[0][0];
    expect(firstArg.context).toContain('follow-up');
    expect(firstArg.context).toContain('previous message');
  });

  it('preserves tool_calls and backend from GovernedTurnResult in returned shape', async () => {
    const agents = makeAgents();
    (agents.runGovernedTurn as jest.Mock).mockResolvedValueOnce({
      ...GOVERNED_RESULT,
      text: 'analysis done',
      tool_calls: [{ plugin_id: 'p', function: 'f', args: {} }],
      backend: 'subscription' as const,
    } satisfies GovernedTurnResult);

    const service = makePanelService(agents);
    const result = await service.chat('run analysis');

    expect(result.response).toBe('analysis done');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.backend).toBe('subscription');
  });
});
