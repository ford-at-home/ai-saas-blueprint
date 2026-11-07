import type { EntitlementProvider } from '@ai-saas-blueprint/entitlement';
import type { WorkflowRun } from '@ai-saas-blueprint/shared';

export interface WorkflowSpec {
  id: string;
  name: string;
  modelId: string;
  systemPrompt: string;
  /** Content hash of the yaml definition. Stamped onto every run. */
  version: string;
  inputs: Array<{ name: string; type: 'string' | 'number' | 'boolean' }>;
}

export interface StartWorkflowInput {
  tenantId: string;
  userId: string;
  workflow: WorkflowSpec;
  input: Record<string, unknown>;
}

/**
 * Thin shell: atomic entitlement reservation → start state machine → write
 * the audit row. Bedrock invocation lives inside the Step Functions state
 * machine; this class just gates and records.
 *
 * Note the order: reservation BEFORE persistRun. If reservation fails we
 * never touch the runs table; if persistRun or startStateMachine fails
 * after a successful reservation we hand back the quota via `releaseRun`
 * so the caller isn't charged for a run we couldn't start.
 */
export class WorkflowRunner {
  constructor(private readonly deps: WorkflowRunnerDeps) {}

  async start(input: StartWorkflowInput): Promise<WorkflowRun> {
    const check = await this.deps.entitlement.reserveRun(
      input.tenantId,
      input.workflow.id,
    );
    if (!check.allowed) {
      throw new EntitlementError(check.reason ?? 'plan_inactive', check.remaining);
    }
    const runId = this.deps.newRunId();
    const run: WorkflowRun = {
      tenantId: input.tenantId,
      runId,
      workflowId: input.workflow.id,
      workflowVersion: input.workflow.version,
      status: 'pending',
      startedAt: new Date().toISOString(),
      input: input.input,
    };
    try {
      await this.deps.persistRun(run);
      await this.deps.startStateMachine(run);
    } catch (err) {
      await this.deps.releaseRun?.(input.tenantId, input.workflow.id).catch(() => {
        // Best-effort: failure to release leaves a quota unit consumed.
        // Logged by the caller; quota resets monthly.
      });
      throw err;
    }
    return run;
  }
}

export class EntitlementError extends Error {
  constructor(public readonly reason: string, public readonly remaining?: number) {
    super(`Entitlement denied: ${reason}`);
    this.name = 'EntitlementError';
  }
}

export interface WorkflowRunnerDeps {
  entitlement: EntitlementProvider;
  newRunId(): string;
  persistRun(run: WorkflowRun): Promise<void>;
  startStateMachine(run: WorkflowRun): Promise<void>;
  /**
   * Optional compensating action when a reserved run cannot actually start.
   * Decrement the monthly counter. Best-effort; failure is logged.
   */
  releaseRun?(tenantId: string, workflowId: string): Promise<void>;
}
