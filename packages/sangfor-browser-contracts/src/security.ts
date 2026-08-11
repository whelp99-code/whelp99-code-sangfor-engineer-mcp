const destructiveEvidenceTokens = [
  'apply',
  'commit',
  'save',
  'delete',
  'remove',
  'erase',
  'submit',
  'confirm',
  'reboot',
  'restart',
  'shutdown',
  'terminate',
  'reset',
  'purge',
  'wipe',
  'destroy',
  'factorydefault',
  '삭제',
  '제거',
  '저장',
  '적용',
  '확인',
  '제출',
  '재시작',
  '재부팅',
  '종료',
  '초기화',
  '포맷',
  '删除',
  '刪除',
  '保存',
  '儲存',
  '应用',
  '應用',
  '提交',
  '确认',
  '確認',
  '重启',
  '重啟',
  '关闭',
  '關閉',
  '重置',
  '清除',
  '格式化',
  '恢复出厂',
  '恢復出廠',
] as const;

export function isReadOnlyEvidenceLabel(label: string): boolean {
  const compact = label
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  if (compact.startsWith('format') || compact.endsWith('format')) return false;
  return !destructiveEvidenceTokens.some((token) => compact.includes(token));
}

export function isLoopbackBrowserTarget(targetUrl: string | undefined): boolean {
  if (!targetUrl) return false;
  try {
    const hostname = new URL(targetUrl).hostname.toLowerCase();
    return hostname === 'localhost'
      || hostname === '[::1]'
      || hostname === '::1'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

export function maskSensitiveMetadataText(text: string): string {
  return text
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 ***')
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|session(?:id)?)((?:\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2***',
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '***',
    );
}
