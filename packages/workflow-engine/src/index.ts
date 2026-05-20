import type { EntitlementProvider } from '@greenscreen/entitlement';
import type { WorkflowRun } from '@greenscreen/shared';

export interface WorkflowSpec {
  id: string;
  name: string;
  modelId: string;
  systemPrompt: string;
  inputs: Array<{ name: string; type: 'string' | 'number' | 'boolean' }>;
}

export interface StartWorkflowInput {
  tenantId: string;
  userId: string;
  workflowId: string;
  input: Record<string, unknown>;
}

/**
 * Thin shell: entitlement check → start state machine → record run.
 * Bedrock invocation lives inside the Step Functions state machine; this
 * class just hands work to AWS and writes audit rows.
 */
export class WorkflowRunner {
  constructor(private readonly deps: WorkflowRunnerDeps) {}

  async start(input: StartWorkflowInput): Promise<WorkflowRun> {
    const check = await this.deps.entitlement.canRunWorkflow(
      input.tenantId,
      input.workflowId,
    );
    if (!check.allowed) {
      throw new EntitlementError(check.reason ?? 'plan_inactive', check.remaining);
    }
    const runId = this.deps.newRunId();
    const run: WorkflowRun = {
      tenantId: input.tenantId,
      runId,
      workflowId: input.workflowId,
      status: 'pending',
      startedAt: new Date().toISOString(),
      input: input.input,
    };
    await this.deps.persistRun(run);
    await this.deps.startStateMachine(run);
    await this.deps.entitlement.recordUsage(input.tenantId, {
      workflowId: input.workflowId,
      runId,
      unit: 'workflow_run',
      quantity: 1,
    });
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
}
