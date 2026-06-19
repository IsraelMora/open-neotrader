import { WsGateway, AgentMessagePayload } from './ws.gateway';
import type { AgentsService, GovernedTurnResult } from '../agents/agents.service';
import type { JwtService } from '@nestjs/jwt';
import type { PluginEventsService } from '../plugins/plugin-events.service';
import { WebSocket } from 'ws';

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeJwt(): jest.Mocked<Pick<JwtService, 'verify'>> {
  return {
    verify: jest.fn().mockReturnValue({ sub: 'u1', username: 'alice', totp_verified: true }),
  };
}

function makeEvents(): jest.Mocked<Pick<PluginEventsService, 'on' | 'emit'>> {
  return {
    on: jest.fn(),
    emit: jest.fn(),
  };
}

function makeAgentsService(
  result: Partial<GovernedTurnResult> = {},
): jest.Mocked<Pick<AgentsService, 'runGovernedTurn'>> {
  const defaultResult: GovernedTurnResult = {
    cycle_id: 'test-cycle',
    text: 'LLM reply',
    tool_calls: [],
    decisions: [],
    sandbox_results: [],
    backend: 'api',
    skills_read: ['skill-a'],
    skills_written: [],
    llm_response: {
      text: 'LLM reply',
      tool_calls: [],
      backend: 'api',
      skills_read: ['skill-a'],
      skills_written: [],
    },
    signalsEmitted: [],
  };
  return {
    runGovernedTurn: jest.fn().mockResolvedValue({ ...defaultResult, ...result }),
  };
}

/**
 * Build a WsGateway with AgentsService (no LlmService — after wiring, llm is no longer injected).
 * We need to cast because NestJS DI is bypassed in unit tests.
 */
function makeGateway(agents: jest.Mocked<Pick<AgentsService, 'runGovernedTurn'>>): WsGateway {
  return new WsGateway(
    makeJwt() as unknown as JwtService,
    agents as unknown as AgentsService,
    makeEvents() as unknown as PluginEventsService,
  );
}

/** Minimal WebSocket client stub that captures send calls. */
function makeClient(): { send: jest.Mock; readyState: number } {
  return { send: jest.fn(), readyState: WebSocket.OPEN };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WsGateway.onAgentMessage — routes through AgentsService.runGovernedTurn', () => {
  it('calls runGovernedTurn with source:chat, correct context/system_prompt; emits agent:response with preserved shape', async () => {
    const agents = makeAgentsService();
    const gateway = makeGateway(agents);
    const client = makeClient();

    const payload: AgentMessagePayload = {
      message: 'What should I trade?',
      context: 'BTC is up 5%',
    };

    await gateway.onAgentMessage(payload, client as unknown as import('ws').WebSocket);

    // Must have called runGovernedTurn with source:'chat'
    expect(agents.runGovernedTurn).toHaveBeenCalledTimes(1);
    expect(agents.runGovernedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'chat',
        context: 'BTC is up 5%',
        system_prompt: 'What should I trade?',
      }),
    );

    // Parse the sent messages — find agent:response
    const sentMessages: Array<{ event: string; data: Record<string, unknown> }> =
      client.send.mock.calls.map(
        ([raw]: [string]) => JSON.parse(raw) as { event: string; data: Record<string, unknown> },
      );

    const responseMsg = sentMessages.find((m) => m.event === 'agent:response');
    expect(responseMsg).toBeDefined();
    expect(responseMsg!.data).toMatchObject({
      text: 'LLM reply',
      tool_calls: [],
      backend: 'api',
      skills_read: ['skill-a'],
      skills_written: [],
    });
    expect(responseMsg!.data['ts']).toBeDefined();
  });

  it('uses empty string as context when payload.context is absent', async () => {
    const agents = makeAgentsService();
    const gateway = makeGateway(agents);
    const client = makeClient();

    const payload: AgentMessagePayload = { message: 'Hello' };

    await gateway.onAgentMessage(payload, client as unknown as import('ws').WebSocket);

    expect(agents.runGovernedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'chat',
        context: '',
        system_prompt: 'Hello',
      }),
    );
  });

  it('emits agent:error when runGovernedTurn throws', async () => {
    const agents = makeAgentsService();
    (agents.runGovernedTurn as jest.Mock).mockRejectedValueOnce(new Error('LLM unavailable'));
    const gateway = makeGateway(agents);
    const client = makeClient();

    const payload: AgentMessagePayload = { message: 'trade now' };

    await gateway.onAgentMessage(payload, client as unknown as import('ws').WebSocket);

    const sentMessages: Array<{ event: string; data: Record<string, unknown> }> =
      client.send.mock.calls.map(
        ([raw]: [string]) => JSON.parse(raw) as { event: string; data: Record<string, unknown> },
      );

    const errorMsg = sentMessages.find((m) => m.event === 'agent:error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.data['message']).toBe('LLM unavailable');
    expect(errorMsg!.data['ts']).toBeDefined();
  });
});
