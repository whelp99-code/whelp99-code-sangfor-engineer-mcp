import { AgentTaskStore, type AgentTask } from './playbook-store.js';
import { asApiError } from './tower-contract.js';

// 에이전트 작업 큐(pm_tasks)의 얇은 REST 표면.
export function createAgentTaskApi(agentTasks: AgentTaskStore) {
  return {
    listAgentTasks(status?: AgentTask['status']): { tasks: AgentTask[] } {
      return { tasks: agentTasks.list(status) };
    },

    async createAgentTask(input: { kind: AgentTask['kind']; payload: AgentTask['payload'] }): Promise<AgentTask> {
      return await agentTasks.create(input);
    },

    async closeAgentTask(id: string, result: AgentTask['result']): Promise<AgentTask> {
      try { return await agentTasks.close(id, result); }
      catch (error) { throw asApiError(error); }
    },

    async cancelAgentTask(id: string): Promise<AgentTask> {
      try { return await agentTasks.cancel(id); }
      catch (error) { throw asApiError(error); }
    },
  };
}
