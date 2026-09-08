// 컨트롤타워 플레이북 도메인 레코드 형태. 저장소·엔진·API·런타임 코덱이 공유한다.

// ── 플레이북 정의 ────────────────────────────────────────────────────────────
export interface PlaybookBlock {
  id: string;                  // 리비전 내 유일, 템플릿 참조 앵커
  type: 'tool' | 'report';
  title?: string;
  toolId?: string;             // type==='tool' 필수
  args?: Record<string, unknown>;  // 값에 템플릿 문자열 허용 (Task 4)
  deviceId?: string;           // 지정 시 v1 인자 병합 규칙 재사용
}

export interface PlaybookRevision {
  rev: number;
  blocks: PlaybookBlock[];
  authoredBy: string;
  note?: string;
  status: 'draft' | 'approved' | 'rejected';
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectReason?: string;
}

export interface Playbook {
  id: string;
  name: string;
  goal: string;
  revisions: PlaybookRevision[];  // rev 오름차순
  createdAt: string;
  updatedAt: string;
  seedKey?: string;               // 기본 제공 시드로 생성된 경우의 멱등 키 (사용자 작성본은 없음)
}

// ── AI 분석 아티팩트 ─────────────────────────────────────────────────────────
export type AnalysisVerdict = 'accepted' | 'dismissed';

export interface AnalysisImprovement {
  observation: string;
  evidenceRunId?: string;
  recommendation: string;
  verdict?: AnalysisVerdict;
  reviewedBy?: string;
}

export interface AnalysisProposal {
  action: string;
  rationale: string;
  linkedPlaybookId?: string;
  verdict?: AnalysisVerdict;
  reviewedBy?: string;
}

export interface PlaybookAnalysis {
  schemaVersion: 1;
  id: string;
  playbookId: string;
  playbookRunId: string;
  summary: string;
  improvements: AnalysisImprovement[];
  proposals: AnalysisProposal[];
  authoredBy: string;
  createdAt: string;
}

// ── 에이전트 작업 큐 ─────────────────────────────────────────────────────────
export type AgentTaskKind = 'assemble' | 'revise' | 'analyze';

export interface AgentTask {
  id: string;
  kind: AgentTaskKind;
  payload: { goal?: string; playbookId?: string; playbookRunId?: string; feedback?: string };
  status: 'open' | 'done' | 'cancelled';
  result?: { playbookId?: string; rev?: number; analysisId?: string; note?: string };
  createdAt: string;
  closedAt?: string;
}
