/**
 * Phase 0 placeholder. Real implementation (Phase 0 task 5):
 *   1. Load workflow spec from workflows/<id>/ via embedded bundle.
 *   2. Call Bedrock InvokeModel with system prompt + user input.
 *   3. Persist output to TENANT#<id> / RUN#<runId>.
 *   4. Write artifact to s3://<bucket>/tenants/<id>/runs/<runId>/output.json
 *   5. Return { runId, status, tokensInput, tokensOutput, outputUri }
 *
 * Invoked by the Step Functions state machine. Input shape comes from
 * StartExecution; today we echo it for wiring verification.
 */
export interface WorkflowRunnerInput {
  tenantId: string;
  runId: string;
  workflowId: string;
  input: Record<string, unknown>;
}

export interface WorkflowRunnerOutput {
  tenantId: string;
  runId: string;
  status: 'succeeded' | 'failed';
  output?: Record<string, unknown>;
  errorMessage?: string;
}

export const handler = async (
  event: WorkflowRunnerInput,
): Promise<WorkflowRunnerOutput> => {
  console.log(JSON.stringify({ msg: 'workflow_runner_invoked', event }));
  return {
    tenantId: event.tenantId,
    runId: event.runId,
    status: 'succeeded',
    output: { placeholder: true, note: 'see docs/phase-0-tasks.md#5-workflow-execution' },
  };
};
