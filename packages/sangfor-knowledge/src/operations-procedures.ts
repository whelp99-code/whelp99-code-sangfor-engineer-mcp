// ─── Operations Procedures Data ─────────────────────────────────────────────
// 실장비 검증 기반: EPP v6.0.4, IAG v13.0.120, CC v3.0.98C

export interface ProcedureItem {
  id: string;
  title: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'on_demand';
  responsible: string;
  steps: string[];
  checklist?: string[];
  notes?: string[];
}

export interface OperationsProcedure {
  category: string;
  categoryLabel: string;
  items: ProcedureItem[];
}

export const DAILY_PROCEDURES: OperationsProcedure = {
  category: 'daily',
  categoryLabel: '일일 모니터링',
  items: [
    {
      id: 'daily_001',
      title: 'Endpoint Secure 대시보드 확인',
      frequency: 'daily',
      responsible: '보안 운영',
      steps: [
        'EPP 관리 콘솔 로그인 (https://<EPP_IP>:8443)',
        'Dashboard > Overview에서 에이전트 온라인/오프라인 현황 확인',
        '오프라인 에이전트 목록 확인 및 원인 파악',
        '신규 탐지 이벤트 수 확인 (Critical/High/Medium)',
        '격리된 에이전트 확인 및 조치 여부 판단',
        '에이전트 업데이트 상태 확인',
      ],
      checklist: [
        '☐ 오프라인 에이전트 5대 이상 증가 여부',
        '☐ Critical 탐지 이벤트 즉시 대응 여부',
        '☐ 시그니처 DB 업데이트 일자 확인 (24시간 이내)',
        '☐ 에이전트 그룹 정책 적용 상태 확인',
      ],
    },
    {
      id: 'daily_002',
      title: 'IAG 대시보드 확인',
      frequency: 'daily',
      responsible: '보안 운영',
      steps: [
        'IAG 관리 콘솔 로그인 (https://<IAG_IP>)',
        'Dashboard > Overview에서 인증 상태 확인',
        'LDAP/ADIUS 인증 서버 연결 상태 확인',
        '네트워크 인터페이스 상태 확인',
        '접근 제어 정책 위반 건수 확인',
        '인증 실패 로그 빈도 확인',
      ],
      checklist: [
        '☐ LDAP/ADIUS 서버 연결 상태 정상',
        '☐ 네트워크 인터페이스 다운 없음',
        '☐ 인증 실패 100건 이상 증가 없음',
        '☐ 정책 위반 로그 이상 없음',
      ],
    },
    {
      id: 'daily_003',
      title: 'Cyber Command 대시보드 확인',
      frequency: 'daily',
      responsible: '보안 운영',
      steps: [
        'CC 관리 콘솔 로그인 (https://<CC_IP>:8443)',
        'Dashboard > Security Overview에서 이벤트 요약 확인',
        'Detection > Threats에서 신규 위협 탐지 확인',
        'Detection > Anomalies에서 이상 탐지 확인',
        'Detection > Logs에서 이벤트 소스 수집 상태 확인',
        'Response > SOAR에서 플레이북 실행 결과 확인',
      ],
      checklist: [
        '☐ 이벤트 소스 연결 끊김 없음',
        '☐ Critical 인시던트 즉시 대응 여부',
        '☐ SOAR 플레이북 실행 실패 건수 확인',
        '☐ 신규 위협 유형 확인 및 대응',
      ],
    },
    {
      id: 'daily_004',
      title: '알림 검토 및 처리',
      frequency: 'daily',
      responsible: '보안 운영',
      steps: [
        '각 제품 콘솔의 알림 메뉴에서 미처리 알림 확인',
        'Critical 알림: 즉시 대응 및 처리',
        'High 알림: 4시간 이내 대응',
        'Medium 알림: 업무 시간 내 처리',
        'Low 알림: 주간 점검 시 검토',
        '알림 처리 이력 기록',
      ],
      checklist: [
        '☐ Critical 알림 0건 유지',
        '☐ High 알림 미처리 3건 이하',
        '☐ 알림 채널(이메일/SMS) 정상 동작 확인',
        '☐ 알림 수신 담당자 목록 최신 상태',
      ],
    },
  ],
};

export const WEEKLY_PROCEDURES: OperationsProcedure = {
  category: 'weekly',
  categoryLabel: '주간 점검',
  items: [
    {
      id: 'weekly_001',
      title: '제품 업데이트 점검',
      frequency: 'weekly',
      responsible: '인프라 운영',
      steps: [
        'EPP: System > Update에서 시그니처 DB 업데이트 일자 확인',
        'IAG: System > Firmware에서 펌웨어 업데이트 가능 버전 확인',
        'CC: Settings > Update에서 센서/커넥터 업데이트 확인',
        '업데이트 공지 확인 (Sangfor 기술 지원 포털)',
        '업데이트 테스트 환경 적용 검토',
        '업데이트 적용 계획 수립',
      ],
      checklist: [
        '☐ EPP 시그니처 DB 24시간 이내 업데이트',
        '☐ IAG 펌웨어 최신 버전 확인',
        '☐ CC 센서/커넥터 업데이트 상태',
        '☐ 업데이트 적용 계획 문서화',
      ],
    },
    {
      id: 'weekly_002',
      title: '백업 검증',
      frequency: 'weekly',
      responsible: '인프라 운영',
      steps: [
        'EPP: 설정 백업 파일 존재 여부 확인',
        'IAG: System > Backup에서 설정 백업 확인',
        'CC: Settings > Backup에서 설정 백업 확인',
        '백업 파일 크기 및 유효성 확인',
        '백업 저장소 용량 확인',
        '백업 스케줄 점검',
      ],
      checklist: [
        '☐ EPP 설정 백업 파일 존재 (최근 7일 이내)',
        '☐ IAG 설정 백업 파일 존재 (최근 7일 이내)',
        '☐ CC 설정 백업 파일 존재 (최근 7일 이내)',
        '☐ 백업 저장소 용량 80% 이하',
      ],
    },
    {
      id: 'weekly_003',
      title: '보안 정책 리뷰',
      frequency: 'weekly',
      responsible: '보안 담당',
      steps: [
        'EPP: Policy > App Control에서 예외 목록 리뷰',
        'IAG: Policy > URL Filtering에서 차단 규칙 리뷰',
        'CC: Detection > Threats에서 탐지 규칙 리뷰',
        '불필요한 예외 항목 제거',
        '새로운 위협 대응 규칙 추가 검토',
        '정책 변경 이력 확인',
      ],
      checklist: [
        '☐ 불필요한 예외 항목 제거',
        '☐ 새로운 위협 규칙 추가 검토',
        '☐ 정책 변경 이력 리뷰',
        '☐ 오탐 발생 건수 확인',
      ],
    },
    {
      id: 'weekly_004',
      title: '로그 리뷰',
      frequency: 'weekly',
      responsible: '보안 운영',
      steps: [
        '전주 로그 요약 리뷰',
        '이상 패턴 탐지 (비정상 접근, 대량 다운로드 등)',
        '인증 실패 패턴 분석',
        '데이터 유출 의심 활동 확인',
        '로그 보존 상태 확인',
        '주간 보안 요약 리포트 작성',
      ],
      checklist: [
        '☐ 이상 접근 패턴 없음',
        '☐ 인증 실패 패턴 정상',
        '☐ 데이터 유출 의심 활동 없음',
        '☐ 주간 보안 요약 리포트 작성',
      ],
    },
  ],
};

export const MONTHLY_PROCEDURES: OperationsProcedure = {
  category: 'monthly',
  categoryLabel: '월간 운영',
  items: [
    {
      id: 'monthly_001',
      title: '성능 분석',
      frequency: 'monthly',
      responsible: '인프라 운영',
      steps: [
        'EPP: 에이전트 응답 시간 및 리소스 사용량 분석',
        'IAG: 네트워크 처리량 및 인증 응답 시간 분석',
        'CC: 로그 수집 처리량 및 탐지 지연 시간 분석',
        '성능 트렌드 차트 확인',
        '병목 구간 식별 및 개선 방안 검토',
        '장비 리소스 추가 검토',
      ],
      checklist: [
        '☐ EPP 에이전트 응답 시간 5초 이하',
        '☐ IAG 인증 응답 시간 2초 이하',
        '☐ CC 로그 수집 지연 1분 이하',
        '☐ 성능 트렌드 차트 리포트 작성',
      ],
    },
    {
      id: 'monthly_002',
      title: '보안 감사',
      frequency: 'monthly',
      responsible: '보안 담당',
      steps: [
        '관리자 계정 권한 감사',
        '비밀번호 정책 적용 상태 확인',
        '감사 로그 보존 기간 확인',
        '접근 권한 변경 이력 리뷰',
        '보안 정책 예외 목록 리뷰',
        '보안 감사 리포트 작성',
      ],
      checklist: [
        '☐ 관리자 계정 최소 권한 적용',
        '☐ 비밀번호 정책 90일 변경 적용',
        '☐ 감사 로그 1년 보존 확인',
        '☐ 접근 권한 변경 이력 리뷰',
        '☐ 보안 감사 리포트 작성',
      ],
    },
    {
      id: 'monthly_003',
      title: '운영 리포트 작성',
      frequency: 'monthly',
      responsible: '보안 운영',
      steps: [
        '월간 보안 이벤트 요약 작성',
        '탐지/격리 이벤트 통계',
        '인시던트 대응 이력 요약',
        '개선 권고 사항 도출',
        '다음 달 운영 계획 수립',
        '리포트 관리자 배포',
      ],
      checklist: [
        '☐ 월간 보안 이벤트 요약 작성',
        '☐ 탐지/격리 이벤트 통계 완료',
        '☐ 인시던트 대응 이력 요약 완료',
        '☐ 개선 권고 사항 도출 완료',
        '☐ 리포트 관리자 배포 완료',
      ],
    },
    {
      id: 'monthly_004',
      title: '백업 및 복구 테스트',
      frequency: 'monthly',
      responsible: '인프라 운영',
      steps: [
        '전월 백업 파일 목록 확인',
        '백업 파일 무결성 검증',
        '임의 백업 파일 복원 테스트',
        '복원 후 정상 동작 확인',
        '복구 절차 문서 업데이트',
        '백업 스케줄 최적화',
      ],
      checklist: [
        '☐ 백업 파일 무결성 검증 완료',
        '☐ 복원 테스트 1건 이상 수행',
        '☐ 복원 후 정상 동작 확인',
        '☐ 복구 절차 문서 업데이트',
      ],
    },
  ],
};

export const INCIDENT_PROCEDURES: OperationsProcedure = {
  category: 'incident',
  categoryLabel: '장애 대응',
  items: [
    {
      id: 'incident_001',
      title: '장애 알림 처리 절차',
      frequency: 'on_demand',
      responsible: '보안 운영',
      steps: [
        '1단계: 알림 수신 및 분류 (Critical/High/Medium/Low)',
        '2단계: Critical 알림은 즉시 담당자에게 통보',
        '3단계: 알림 상세 정보 기록 (제품, 메뉴, 대상, 시간)',
        '4단계: 자가 처리 가능한 경우 즉시 조치',
        '5단계: 자가 처리 불가능 시 벤더 지원 요청',
        '6단계: 장애 처리 이력 기록',
      ],
      checklist: [
        '☐ 알림 수신 및 분류 완료',
        '☐ Critical 알림 즉시 통보 완료',
        '☐ 알림 상세 정보 기록 완료',
        '☐ 조치 또는 벤더 지원 요청 완료',
        '☐ 장애 처리 이력 기록 완료',
      ],
    },
    {
      id: 'incident_002',
      title: '벤더 지원 요청 절차',
      frequency: 'on_demand',
      responsible: '인프라 운영',
      steps: [
        'Sangfor 기술 지원 포털 (tac.sangfor.com) 접속',
        '지원 티켓 생성',
        '필요 정보 준비: 제품 버전, 시리얼 번호, 장애 현상',
        '재현 절차 및 로그 파일 첨부',
        '긴급 장애: Sangfor TAC 핫라인 연락',
        '지원 티켓 상태 모니터링',
      ],
      checklist: [
        '☐ 지원 티켓 번호 확인',
        '☐ 필요 정보 준비 완료',
        '☐ 로그 파일 첨부 완료',
        '☐ 티켓 상태 모니터링',
      ],
    },
    {
      id: 'incident_003',
      title: '장애 복구 절차',
      frequency: 'on_demand',
      responsible: '인프라 운영',
      steps: [
        '1단계: 장애 원인 분석 및 영향 범위 파악',
        '2단계: 백업/스냅샷에서 복원 또는 설정 롤백',
        '3단계: 복구 후 정상 동작 검증',
        '4단계: 장애 보고서 작성',
        '5단계: 레슨러닝 기록 및 개선 조치',
      ],
      checklist: [
        '☐ 장애 원인 분석 완료',
        '☐ 복원/롤백 수행 완료',
        '☐ 정상 동작 검증 완료',
        '☐ 장애 보고서 작성 완료',
        '☐ 레슨러닝 기록 완료',
      ],
    },
  ],
};

export const TROUBLESHOOTING_FAQ: OperationsProcedure = {
  category: 'troubleshooting',
  categoryLabel: '트러블슈팅 FAQ',
  items: [
    {
      id: 'ts_001',
      title: '에이전트 오프라인 문제 해결',
      frequency: 'on_demand',
      responsible: '보안 운영',
      steps: [
        '에이전트 서비스 상태 확인: services.msc > Sangfor Agent Service',
        '네트워크 연결 확인: 관리 서버 IP ping 테스트',
        '방화벽 포트 확인: TCP 443, 8080 개방 여부',
        '에이전트 로그 확인: C:\\ProgramData\\Sangfor\\Agent\\logs',
        '에이전트 재시작: 서비스 중지 후 재시작',
        '에이전트 재배포: 관리 콘솔에서 재배포 실행',
      ],
      notes: [
        '에이전트 오프라인 원인: 네트워크 차단, 서비스 중지, OS 업데이트',
        '에이전트 로그 경로: C:\\ProgramData\\Sangfor\\Agent\\logs',
        '에이전트 재시작 후 5분 이내 온라인 복귀 확인',
      ],
    },
    {
      id: 'ts_002',
      title: 'IAG 인증 실패 문제 해결',
      frequency: 'on_demand',
      responsible: '보안 운영',
      steps: [
        'LDAP/ADIUS 서버 연결 상태 확인',
        '인증 서버 로그 확인',
        '바인딩 계정 권한 확인',
        '사용자 계정 상태 확인 (잠금/만료)',
        '네트워크 연결 확인',
        'IAG 인증 로그 확인: Activity Audit > Authentication Log',
      ],
      notes: [
        'LDAP 인증 실패 원인: 서버 다운, 바인딩 계정 만료, 네트워크 차단',
        'ADIUS 인증 실패 원인: 시크릿 키 불일치, 서버 다운',
        '인증 실패 시 LDAP/ADIUS 서버 관리자에게 먼저 확인 요청',
      ],
    },
    {
      id: 'ts_003',
      title: 'CC 이벤트 소스 연결 끊김 해결',
      frequency: 'on_demand',
      responsible: '보안 운영',
      steps: [
        '이벤트 소스 상태 확인: Detection > Event Sources',
        'Syslog 서버 연결 확인: telnet <syslog_ip> 514',
        '네트워크 연결 확인: 방화벽 포트 개방 여부',
        'Syslog 서버 디스크 용량 확인',
        '이벤트 소스 재연결: Reconnect 버튼 클릭',
        '이벤트 소스 재등록: 새 이벤트 소스 등록',
      ],
      notes: [
        '이벤트 소스 끊김 원인: 네트워크 차단, Syslog 서버 다운, 디스크 부족',
        '이벤트 소스 재연결 후 5분 이내 정상 수집 확인',
        'Syslog 서버 디스크 용량 80% 이상 시 로그 정리 필요',
      ],
    },
    {
      id: 'ts_004',
      title: '오탐(False Positive) 처리',
      frequency: 'on_demand',
      responsible: '보안 담당',
      steps: [
        '탐지 로그에서 오탐 대상 식별',
        '오탐 원인 분석 (시그니처 불일치, 정상 앱)',
        '화이트리스트에 추가: Policy > Exceptions > Add',
        '오탐 건수 모니터링 (1주일 이상)',
        '오탐 재발 방지 조치',
        '오탐 처리 이력 기록',
      ],
      notes: [
        '오탐 화이트리스트는 반드시 관리자 승인 후 적용',
        '화이트리스트 항목은 정기적으로 리뷰하여 불필요한 항목 제거',
        '오탐 발생 빈도가 높은 경우 탐지 규칙 튜닝 검토',
      ],
    },
  ],
};

export const BACKUP_RECOVERY_PROCEDURES: OperationsProcedure = {
  category: 'backup_recovery',
  categoryLabel: '백업 및 복구',
  items: [
    {
      id: 'backup_001',
      title: '설정 백업 절차',
      frequency: 'weekly',
      responsible: '인프라 운영',
      steps: [
        'EPP: System > Backup > Backup Now 클릭',
        'IAG: System > Backup > Backup Now 클릭',
        'CC: Settings > Backup > Backup Now 클릭',
        '백업 파일 저장 위치 확인',
        '백업 파일 크기 및 유효성 확인',
        '백업 이력 기록',
      ],
      checklist: [
        '☐ EPP 설정 백업 완료',
        '☐ IAG 설정 백업 완료',
        '☐ CC 설정 백업 완료',
        '☐ 백업 파일 저장 위치 확인',
        '☐ 백업 이력 기록 완료',
      ],
    },
    {
      id: 'backup_002',
      title: '데이터 백업 절차',
      frequency: 'monthly',
      responsible: '인프라 운영',
      steps: [
        'EPP: 탐지 로그 내보내기 (CSV/JSON)',
        'IAG: 인터넷 접근 로그 내보내기',
        'CC: 이벤트 소스 로그 내보내기',
        '백업 파일 암호화 (권장)',
        '백업 파일 외부 저장소 복사',
        '백업 파일 목록 및 해시값 기록',
      ],
      checklist: [
        '☐ EPP 탐지 로그 내보내기 완료',
        '☐ IAG 인터넷 접근 로그 내보내기 완료',
        '☐ CC 이벤트 소스 로그 내보내기 완료',
        '☐ 백업 파일 암호화 완료',
        '☐ 백업 파일 외부 저장소 복사 완료',
      ],
    },
    {
      id: 'backup_003',
      title: '복구 절차',
      frequency: 'on_demand',
      responsible: '인프라 운영',
      steps: [
        '장애 제품 식별 및 원인 분석',
        '백업 파일 확인 및 선택',
        '복원 실행: System > Backup > Restore',
        '복원 후 설정 확인',
        '정상 동작 검증',
        '복구 이력 기록',
      ],
      checklist: [
        '☐ 장애 제품 및 원인 식별 완료',
        '☐ 백업 파일 확인 완료',
        '☐ 복원 실행 완료',
        '☐ 설정 확인 완료',
        '☐ 정상 동작 검증 완료',
        '☐ 복구 이력 기록 완료',
      ],
    },
  ],
};

export function getAllOperationsProcedures(): OperationsProcedure[] {
  return [
    DAILY_PROCEDURES,
    WEEKLY_PROCEDURES,
    MONTHLY_PROCEDURES,
    INCIDENT_PROCEDURES,
    TROUBLESHOOTING_FAQ,
    BACKUP_RECOVERY_PROCEDURES,
  ];
}

export function getOperationsProcedure(category: string): OperationsProcedure | undefined {
  return getAllOperationsProcedures().find(p => p.category === category);
}
