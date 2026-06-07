import type { StopCondition, ToolSet } from "ai";

/**
 * Never stops on step count alone. The agent's own decision to stop (no more
 * tool calls, final text emitted) is the only termination signal; wall-clock
 * timeouts in the runner are the runaway protection.
 */
export const NEVER_STOP: StopCondition<ToolSet> = () => false;
