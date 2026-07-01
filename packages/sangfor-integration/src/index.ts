/**
 * @sangfor/integration — standard integration recipes (AD/LDAP, RADIUS, SIEM/syslog).
 * Assembles a cited step-by-step guide (prerequisites → steps → validation → pitfalls)
 * for the Service-1 "guide" flow. Human performs the actual config; unknown integration
 * types return null (no fabrication).
 */

export type IntegrationType = 'LDAP' | 'RADIUS' | 'SIEM_SYSLOG';

export interface IntegrationGuide {
  type: IntegrationType;
  product?: string;
  title: string;
  prerequisites: string[];
  steps: string[];
  validation: string[];
  pitfalls: string[];
  source: string;
  disclaimer: string;
}

const ALIASES: Record<string, IntegrationType> = {
  ldap: 'LDAP', ad: 'LDAP', 'active directory': 'LDAP', 'ldap/ad': 'LDAP',
  radius: 'RADIUS',
  siem: 'SIEM_SYSLOG', syslog: 'SIEM_SYSLOG', siem_syslog: 'SIEM_SYSLOG', 'siem/syslog': 'SIEM_SYSLOG',
};

const DISCLAIMER = '참고용 표준 연동 가이드입니다. 실제 설정과 최종 적용은 담당 엔지니어가 수행하세요. 제품/버전별 메뉴 명칭은 콘솔에서 확인하십시오.';

const RECIPES: Record<IntegrationType, Omit<IntegrationGuide, 'type' | 'product' | 'disclaimer'>> = {
  LDAP: {
    title: 'AD/LDAP 인증 소스 연동',
    prerequisites: [
      'AD/LDAP 서버 도달성(389, LDAPS는 636) 및 방화벽 허용',
      '읽기 권한을 가진 bind 계정(DN + 비밀번호) — 잠금 정책 확인',
      'Base DN 및 사용자 검색 필터(예: sAMAccountName)',
      'LDAPS 사용 시 CA 인증서, NTP 시간 동기(AD와 시간차 5분 이내)',
    ],
    steps: [
      '인증 소스 관리 화면에서 새 LDAP/AD 소스 추가',
      '서버 IP/포트, 암호화(LDAP/LDAPS) 지정',
      'bind DN과 비밀번호 입력',
      'Base DN + 사용자/그룹 검색 필터 설정',
      '연결/조회 테스트로 사용자 목록 반환 확인',
      '인증 정책/사용자 그룹에 이 소스를 매핑',
    ],
    validation: [
      '테스트 조회가 실제 사용자를 반환',
      '테스트 사용자가 실제 로그인 성공',
      '인증 로그에 성공 이벤트 기록',
    ],
    pitfalls: [
      'bind 계정 비밀번호 만료/잠금',
      '잘못된 Base DN(사용자 미검색)',
      'AD와 시간차(Kerberos/토큰 실패)',
      'LDAPS 인증서 미신뢰',
    ],
    source: 'Sangfor IAG v13.0.120 User Manual — Access Management / Authentication (LDAP)',
  },
  RADIUS: {
    title: 'RADIUS 인증 연동',
    prerequisites: [
      'RADIUS 서버 도달성(1812/UDP)',
      '공유 시크릿(shared secret)',
      'NAS(Sangfor 장비) 클라이언트 등록(NAS-IP)',
    ],
    steps: [
      '인증 소스에서 RADIUS 추가',
      '서버 IP/포트(1812), 공유 시크릿 입력',
      '인증 프로토콜(PAP/CHAP/MSCHAPv2) 지정',
      '연결 테스트',
      '인증 정책에 매핑',
    ],
    validation: ['테스트 계정 인증 성공', 'RADIUS 서버 로그에 Access-Accept 확인'],
    pitfalls: ['공유 시크릿 불일치', 'NAS-IP 미등록', '방화벽 1812 차단'],
    source: 'Sangfor IAG v13.0.120 User Manual — Access Management / RADIUS',
  },
  SIEM_SYSLOG: {
    title: 'SIEM/Syslog 로그 포워딩 연동',
    prerequisites: [
      'SIEM/syslog 수집기 IP/포트(514/UDP 또는 TCP/TLS)',
      '로그 포맷 합의(CEF/JSON/LEEF)',
      '장비→수집기 네트워크 경로/방화벽 허용, 처리량(EPS) 여유',
    ],
    steps: [
      '로그/Data Sync > Syslog(또는 SIEM 연동) 화면 진입',
      '수집기 IP/포트/전송(UDP/TCP/TLS) 지정',
      '포맷(CEF/JSON) 선택, 전송할 로그 유형 선택',
      '포워딩 활성화',
    ],
    validation: [
      'SIEM에서 이벤트 수신 확인',
      '포맷 파싱 정상(필드 매핑)',
      '지속 처리량에서 손실 없음',
    ],
    pitfalls: ['포맷 불일치(파싱 실패)', '처리량 초과 손실', '방화벽/TLS 인증서'],
    source: 'Sangfor product User Manual — Logs / Syslog Forwarding',
  },
};

export function listIntegrationTypes(): IntegrationType[] {
  return Object.keys(RECIPES) as IntegrationType[];
}

export function normalizeIntegrationType(input: string): IntegrationType | null {
  if (typeof input !== 'string') return null;
  const k = input.trim().toLowerCase();
  return ALIASES[k] ?? (RECIPES[input as IntegrationType] ? (input as IntegrationType) : null);
}

export function generateIntegrationGuide(type: string, product?: string): IntegrationGuide | null {
  const t = normalizeIntegrationType(type);
  if (!t) return null;
  const r = RECIPES[t];
  return { type: t, product, ...r, disclaimer: DISCLAIMER };
}
