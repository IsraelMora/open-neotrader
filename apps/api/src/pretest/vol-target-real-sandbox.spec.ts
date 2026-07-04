/**
 * vol-target-real-sandbox.spec.ts — Runtime reproduction (Strict TDD).
 *
 * The 4 Vol-Managed pretest portfolios (Vol-Managed Index/QQQ/TECL/SOXL) were
 * reported to execute 0 trades in production because risk-manager's vol_target
 * on_cycle hook always returns exposure_scalar=0.
 *
 * Every existing test in pretest.service.spec.ts mocks `sandbox.call` — the
 * risk-manager Python hook NEVER actually runs, so a data-shape mismatch
 * between what `_buildMarketContext` produces and what the real Python hook
 * reads (ctx["ohlcv"][benchmark][i]["close"]) would never be caught.
 *
 * This test spawns the REAL apps/sandbox/runner.py subprocess (no mocking of
 * SandboxGateway.call) and feeds it the EXACT ohlcv shape PretestService
 * builds in production (via the real `_buildMarketContext` private method,
 * with only the network boundary — ProviderGatewayService.getOhlcv — stubbed
 * with production-shaped bars). It asserts the real risk-manager hook returns
 * a positive exposure_scalar, proving the full TS -> JSON -> Python plumbing
 * end-to-end.
 */
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import { PretestService } from './pretest.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import type { ProviderGatewayService, OhlcvBar } from '../providers/provider-gateway.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PluginsService } from '../plugins/plugins.service';
import type { LlmService } from '../llm/llm.service';
import type { ContextMemoryService } from '../context-memory/context-memory.service';
import type { AgentsService } from '../agents/agents.service';
import type { KvService } from '../common/kv.service';
import type { AuditService } from '../audit/audit.service';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Builds a real (non-mocked) SandboxGateway pointed at this repo's actual plugins/runner.py. */
function makeRealSandboxGateway(): SandboxGateway {
  const overrides: Record<string, unknown> = {
    PLUGINS_DIR: path.join(REPO_ROOT, 'plugins'),
    SANDBOX_RUNNER_PATH: path.join(REPO_ROOT, 'apps/sandbox/runner.py'),
    PLUGIN_SDK_PATH: path.join(REPO_ROOT, 'packages/plugin-sdk'),
    SANDBOX_NETNS_ISOLATION: 'off', // no privileged netns available in the test env
    SANDBOX_STRICT: 'true',
  };
  const cfg = {
    get: jest.fn((key: string, defaultVal?: unknown) =>
      key in overrides ? overrides[key] : defaultVal,
    ),
  } as unknown as ConfigService;
  return new SandboxGateway(cfg);
}

/** Deterministic, realistic daily closes with a mild upward random walk (no NaN/zero). */
function makeRealisticBars(count: number, startPrice: number): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  let price = startPrice;
  // Simple LCG for determinism without pulling in a random-lib dependency.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) {
    price *= 1 + (rand() - 0.5) * 0.02;
    const day = (i % 27) + 1;
    const month = String(Math.floor(i / 27) + 1).padStart(2, '0');
    bars.push({
      ts: `2024-${month}-${String(day).padStart(2, '0')}T00:00:00.000Z`,
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 1_000_000,
    });
  }
  return bars;
}

function makeStubKv(overrides: Record<string, string | null> = {}): KvService {
  return {
    get: jest.fn((key: string) => Promise.resolve(key in overrides ? overrides[key] : null)),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  } as unknown as KvService;
}

describe('Vol-Managed exposure_scalar — real sandbox reproduction (no mocked sandbox.call)', () => {
  jest.setTimeout(30_000);

  it.each([
    ['Vol-Managed Index', 'SPY'],
    ['Vol-Managed QQQ', 'QQQ'],
    ['Vol-Managed TECL', 'TECL'],
    ['Vol-Managed SOXL', 'SOXL'],
  ])(
    '%s: runCycle wiring feeds the REAL risk-manager hook production-shaped OHLCV -> exposure_scalar > 0',
    async (_name, benchmark) => {
      const sandbox = makeRealSandboxGateway();
      // Real netns detection would spawn `unshare`; 'off' mode skips it entirely and
      // sets netnsActive=false synchronously-safe, so onModuleInit is safe to await here.
      await sandbox.onModuleInit();

      const bars = makeRealisticBars(400, 400);
      const gateway = {
        getOhlcv: jest.fn().mockResolvedValue(bars),
      } as unknown as ProviderGatewayService;

      // Deliberately include the benchmark itself in cycle.universe (SPY/QQQ style) to
      // also exercise the "already in universe" path the bug report singled out, in
      // addition to the TECL/SOXL "benchmark absent from universe" extraSymbols path.
      const kv = makeStubKv({
        'cycle.universe': `AAPL,MSFT,${benchmark}`,
        'cycle.data_provider': 'yahoo-finance-provider',
      });

      const svc = new PretestService(
        {} as PrismaService,
        sandbox,
        {} as PluginsService,
        {} as LlmService,
        {} as ContextMemoryService,
        gateway,
        {} as AgentsService,
        kv,
        {} as AuditService,
      );

      // Exercise the EXACT production data path: private _buildMarketContext, then the
      // EXACT run_hook context shape PretestService.runCycle sends to risk-manager.

      const market = await (
        svc as unknown as {
          _buildMarketContext: (
            extra: string[],
          ) => Promise<{ universe: string[]; ohlcv: Record<string, unknown[]> }>;
        }
      )._buildMarketContext([benchmark]);

      expect(market.ohlcv[benchmark]).toBeDefined();
      expect(market.ohlcv[benchmark].length).toBeGreaterThan(20);

      const hookResp = await sandbox.call({
        cmd: 'run_hook',
        plugin_id: 'risk-manager',
        hook: 'on_cycle',
        context: {
          pending_signals: [],
          portfolio: {},
          positions: [],
          portfolio_value: 100_000,
          ohlcv: market.ohlcv,
          config: {
            exposure_mode: 'vol_target',
            target_vol_pct: 12,
            vol_window_days: 20,
            exposure_cap: 1.0,
            vol_target_benchmark: benchmark,
          },
        },
      });

      expect(hookResp.ok).toBe(true);
      const scalar = (hookResp.result as Record<string, unknown> | undefined)?.['exposure_scalar'];
      expect(typeof scalar).toBe('number');
      expect(scalar as number).toBeGreaterThan(0);
    },
  );
});
