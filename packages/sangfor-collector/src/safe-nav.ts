export const ACTION_BUTTON_DENYLIST: string[] = [
  'save',
  'apply',
  'delete',
  'remove',
  'restore default',
  'reset',
  'enable',
  'disable',
  'confirm',
  'submit',
  'ok',
  'create',
  'edit',
  'modify',
  'activate',
  'deactivate',
  'factory',
  'reboot',
  'shutdown',
  'isolate',
  'deploy',
  '저장',
  '적용',
  '삭제',
  '복원',
  '초기화',
  '기본값',
  '확인',
  '사용',
  '해제',
  '재시작',
  '격리',
  '생성',
  '수정',
];

export function isSafeNavLabel(label: string): boolean {
  const t = label.trim().toLowerCase();
  if (!t || t.length > 40) return false;
  // Multi-word action phrases ("restore default", "apply to ...") → substring match.
  const phrases = ACTION_BUTTON_DENYLIST.filter((w) => w.includes(' '));
  if (phrases.some((p) => t.includes(p))) return false;
  // Single tokens → whole-word match, so a nav label is not blocked merely for
  // CONTAINING the token (e.g. '사용' must not block '사용자 관리'/User Management,
  // 'ok' must not block 'Book'/'Token', '저장' must not block '저장소'/storage).
  const singles = ACTION_BUTTON_DENYLIST.filter((w) => !w.includes(' '));
  const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return !singles.some((s) => words.includes(s));
}
