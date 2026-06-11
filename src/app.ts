type NodeMetrics = {
  cpu_percent: number;
  memory_used: number;
  memory_total: number;
  disk_used: number;
  disk_total: number;
};

type LatticeNode = {
  id: string;
  name: string;
  role: string;
  online: boolean;
  agent_version: string;
  last_seen: string;
  metrics: NodeMetrics;
};

type TaskResult = {
  task_id: string;
  node_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  error: string;
};

type Approval = {
  id: string;
  node_id: string;
  status: string;
  plan: string;
};

type KVEntry = {
  key: string;
  value: string;
};

type WorkerScript = {
  id: string;
  name: string;
};

type AuditEvent = {
  at: string;
  action: string;
  decision: string;
  actor_id: string;
  node_id: string;
};

type AppState = {
  csrf: string;
  nodes: LatticeNode[];
  tasks: Array<{ status: string }>;
  results: TaskResult[];
  approvals: Approval[];
  kv: KVEntry[];
  workers: WorkerScript[];
  audit: AuditEvent[];
};

export {};

