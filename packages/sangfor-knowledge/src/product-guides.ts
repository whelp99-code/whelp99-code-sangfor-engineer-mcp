// ─── Product-Level Detailed Setting Guides ──────────────────────────────────
// 실장비 검증 데이터 기반: EPP v6.0.4, IAG v13.0.120, CC v3.0.98C

export interface SettingStep {
  step: number;
  title: string;
  menuPath: string;
  description: string;
  details: string[];
  notes?: string[];
}

export interface SettingSection {
  id: string;
  title: string;
  description: string;
  steps: SettingStep[];
}

export interface ProductSettingGuide {
  product: string;
  productLabel: string;
  version: string;
  sections: SettingSection[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// EPP (Endpoint Secure) Setting Guide
// ═══════════════════════════════════════════════════════════════════════════════

export const EPP_SETTING_GUIDE: ProductSettingGuide = {
  product: 'ENDPOINT_SECURE',
  productLabel: 'Endpoint Secure (EPP)',
  version: 'v6.0.4',
  sections: [
    {
      id: 'epp_init',
      title: '1. 초기 설정',
      description: 'Endpoint Secure 관리 콘솔 초기 설정 및 에이전트 배포 환경 구성 절차를 안내합니다.',
      steps: [
        {
          step: 1,
          title: '관리 콘솔 접속',
          menuPath: 'Browser > https://<EPP_IP>:8443',
          description: '관리 콘솔에 로그인합니다.',
          details: [
            '기본 관리자 계정: admin',
            '초기 비밀번호는 제품 설치 시 설정한 값 사용',
            '로그인 후 반드시 관리자 비밀번호 변경 권장',
            'TLS 인증서 검증 필요 (자체 인증서 사용 시 브라우저 경고 무시)',
          ],
        },
        {
          step: 2,
          title: '에이전트 배포 URL 확인',
          menuPath: 'Deployment > Agent Deployment',
          description: '에이전트 설치에 필요한 배포 URL 및 패키지를 확인합니다.',
          details: [
            '에이전트 설치 파일 다운로드 경로 확인',
            '배포 URL: https://<EPP_IP>:8443/api/v1/agent/package',
            '네트워크 공유 폴더를 통한 대량 배포 시 공유 경로 설정',
            '원격 설치(SMS/GPO) 적용 시 인증 정보 확인',
          ],
          notes: ['네트워크 방화벽에서 EPP 포트(8443, 8080) 개방 필요', '에이전트-관리 서버 간 통신 포트: TCP 443, 8080'],
        },
        {
          step: 3,
          title: '에이전트 설치 방법',
          menuPath: 'Deployment > Agent Deployment > Install',
          description: '에이전트를 엔드포인트에 배포하는 방법을 선택합니다.',
          details: [
            '수동 설치: 에이전트 설치 파일을 엔드포인트에서 직접 실행',
            '원격 설치: 관리 콘솔에서 대상 IP를 지정하여 원격 배포',
            'GPO 배포: 도메인 그룹 정책을 통한 자동 배포',
            '네트워크 공유: 공유 폴더에서 설치 파일 실행',
            '에이전트 타입 선택: Full Agent (진단+방어) / Light Agent',
          ],
          notes: ['Windows XP/2003는 지원 불가', 'Linux 에이전트는 별도 패키지 필요'],
        },
        {
          step: 4,
          title: '에이전트 정책 동기화',
          menuPath: 'Policy > Agent Policy > Sync',
          description: '에이전트에 적용할 정책을 동기화합니다.',
          details: [
            '에이전트가 설치되면 관리 콘솔에서 자동으로 정책 동기화',
            '동기화 간격: 기본 30분, 수동 동기화 가능',
            '그룹별 정책 적용: 기본 그룹 / 사용자 정의 그룹',
            '에이전트 상태 확인: Dashboard > Endpoint Status',
          ],
          notes: ['동기화 실패 시 네트워크 연결 및 에이전트 서비스 상태 확인'],
        },
        {
          step: 5,
          title: '관리자 계정 및 권한 설정',
          menuPath: 'System > Administration > Account Management',
          description: '관리자 계정과 역할 기반 접근 제어를 설정합니다.',
          details: [
            '관리자 계정 생성 및 역할 할당',
            '역할 유형: Super Admin / Admin / Auditor / Operator',
            '最小 권한 원칙: 감사 담당자는 읽기 전용',
            'LDAP/AD 연동 시 외부 인증 소스 설정',
            '세션 타임아웃 설정 (기본 30분)',
          ],
        },
      ],
    },
    {
      id: 'epp_app_control',
      title: '2. App Control 규칙 설정',
      description: '어플리케이션 제어 규칙을 설정하여 허용/차단 애플리케이션을 관리합니다.',
      steps: [
        {
          step: 1,
          title: 'App Control 활성화',
          menuPath: 'Policy > App Control',
          description: 'App Control 모듈을 활성화하고 규칙을 설정합니다.',
          details: [
            'App Control 활성화: Policy > App Control > Enable',
            '규칙 유형: White List (화이트리스트) / Black List (블랙리스트)',
            'White List 모드: 허용된 애플리케이션만 실행 가능',
            'Black List 모드: 차단된 애플리케이션 실행 차단',
            'Default Action: Allow / Block 선택',
          ],
        },
        {
          step: 2,
          title: '블랙리스트 규칙 추가',
          menuPath: 'Policy > App Control > Add Rule > Blacklist',
          description: '차단할 애플리케이션 규칙을 추가합니다.',
          details: [
            '규칙 이름: 직관적인 이름으로 설정 (예: "P2P 차단")',
            'Application Type: 실행 파일명 / 경로 / 해시값',
            'Match Method: Exact Match / Wildcard / Hash Match',
            'Effect: Block (실행 차단) / Quarantine (격리)',
            'Priority: 규칙 우선순위 설정 (높은 숫자가 우선)',
            'Exception: 특정 사용자/그룹 예외 설정',
          ],
          notes: ['블랙리스트는 공격 도구, P2P, 불필요한 앱 차단에 적합', '실수로 필수 앱 차단 방지를 위해 테스트 후 적용'],
        },
        {
          step: 3,
          title: '화이트리스트 규칙 추가',
          menuPath: 'Policy > App Control > Add Rule > Whitelist',
          description: '허용할 애플리케이션 규칙을 추가합니다.',
          details: [
            '규칙 이름: 직관적인 이름으로 설정',
            'Application Type: 실행 파일명 / 경로 / 해시값',
            'Match Method: Exact Match / Wildcard / Hash Match',
            'Effect: Allow (실행 허용)',
            'Business Critical 앱은 화이트리스트에 포함',
          ],
          notes: ['화이트리스트 모드는 보안이 높지만 관리 부담 증가', 'Office, ERP, 브라우저 등 필수 앱은 반드시 허용 목록에 포함'],
        },
        {
          step: 4,
          title: '규칙 테스트 및 적용',
          menuPath: 'Policy > App Control > Test Mode',
          description: '규칙을 테스트 모드로 적용한 후 검증합니다.',
          details: [
            '테스트 모드: 규칙을 로그만 기록하고 차단하지 않음',
            '테스트 기간: 최소 1~2주 권장',
            '테스트 결과 분석: 차단 대상 앱 확인',
            '테스트 후 정책 적용: Test Mode 해제',
          ],
          notes: ['테스트 결과에서 오탐 발생 시 규칙 조정 필요'],
        },
      ],
    },
    {
      id: 'epp_malware_scan',
      title: '3. Malware Scan 스케줄 설정',
      description: '악성코드 스캔 스케줄을 설정합니다.',
      steps: [
        {
          step: 1,
          title: '실시간 보호 설정',
          menuPath: 'Policy > Anti-Malware > Real-time Protection',
          description: '실시간 악성코드 탐지를 활성화합니다.',
          details: [
            'Real-time Protection: Enable',
            'Scan On Access: 파일 접근 시 실시간 검사',
            'Scan On Write: 파일 쓰기 시 검사',
            'Scan Network Drive: 네트워크 드라이브 검사 여부',
            'Heuristic Scan: 휴리스틱 분석 활성화',
            'Low Risk Action: Log / Block / Quarantine',
            'Medium Risk Action: Log / Block / Quarantine',
            'High Risk Action: Log / Block / Quarantine + Alert',
          ],
        },
        {
          step: 2,
          title: '예약 스캔 스케줄 설정',
          menuPath: 'Policy > Anti-Malware > Scheduled Scan',
          description: '정기 악성코드 스캔 스케줄을 설정합니다.',
          details: [
            '스캔 유형: Quick Scan / Full Scan / Custom Scan',
            'Quick Scan: 시스템 영역만 스캔 (빠름)',
            'Full Scan: 전체 디렉토리 스캔 (느림, 주 1회 권장)',
            'Custom Scan: 사용자 정의 경로 스캔',
            '스캔 스케줄: 매주 일요일 새벽 2시 (권장)',
            '스캔 대상 경로: C:\\, D:\\, 네트워크 공유',
            '스캔 제외 경로: 백업 폴더, 개발 도구 디렉토리',
          ],
          notes: ['업무 시간 중 스캔은 성능 저하 가능 → 비업무 시간 스캔 권장'],
        },
        {
          step: 3,
          title: '수동 스캔 실행',
          menuPath: 'Assets > Endpoint List > Action > Scan',
          description: '엔드포인트에서 수동 스캔을 실행합니다.',
          details: [
            '관리 콘솔에서 특정 에이전트 선택',
            'Action > Scan 선택',
            '스캔 유형 선택: Quick / Full / Custom',
            '스캔 시작 및 진행 상태 모니터링',
            '스캔 결과 확인: Detection Log',
          ],
        },
      ],
    },
    {
      id: 'epp_behavior_control',
      title: '4. Behavior Control 정책 설정',
      description: '행위 기반 탐지(EDR) 정책을 설정합니다.',
      steps: [
        {
          step: 1,
          title: 'Behavior Control 활성화',
          menuPath: 'Policy > Behavior Control',
          description: '행위 기반 탐지를 활성화하고 모니터링 모드로 시작합니다.',
          details: [
            'Behavior Control: Enable',
            '_monitor mode: 탐지만 하고 차단하지 않음 (2주 권장)',
            'enforce mode: 탐지 후 자동 차단/격리',
            '탐지 대상: Ransomware, Fileless Attack, Living-off-the-Land',
            'Protection:ansomware Protection 활성화',
            'Protection: Memory Protection 활성화',
            'Protection: Exploit Protection 활성화',
          ],
          notes: ['Monitor mode로 2주 이상 운영 후 오탐 분석 → enforce 모드 전환 권장'],
        },
        {
          step: 2,
          title: '탐지 규칙 튜닝',
          menuPath: 'Policy > Behavior Control > Detection Rules',
          description: '탐지 규칙을 튜닝하여 오탐을 줄입니다.',
          details: [
            '기본 규칙 유지: Sangfor 기본 탐지 규칙은 권장',
            'Custom Rule: 특정 앱/행위에 대한 사용자 정의 규칙',
            'False Positive Whitelist: 오탐 앱/파일 예외 목록',
            'Severity Level: Critical / High / Medium / Low',
            'Auto-Response: 탐지 시 자동 격리/차단 여부',
          ],
        },
      ],
    },
    {
      id: 'epp_device_control',
      title: '5. Device Control 설정',
      description: '저장매체 및 USB 기기 제어를 설정합니다.',
      steps: [
        {
          step: 1,
          title: 'Device Control 활성화',
          menuPath: 'Policy > Device Control',
          description: 'USB/저장매체 제어를 활성화합니다.',
          details: [
            'Device Control: Enable',
            'USB Storage: Block / Allow / Read-Only',
            'CD/DVD: Block / Allow',
            'Floppy Disk: Block (권장)',
            'Bluetooth: Block / Allow',
            ' Wireless Adapter: Block / Allow',
            'Device Whitelist: 허용된 USB 기기 목록 (MAC/Serial 기반)',
          ],
        },
        {
          step: 2,
          title: 'USB 기기 예외 설정',
          menuPath: 'Policy > Device Control > Device Whitelist',
          description: '허용된 USB 기기를 화이트리스트에 등록합니다.',
          details: [
            'USB 기기 등록: 기기 연결 시 자동 감지 후 등록',
            '기기 정보: Device Name / Vendor ID / Product ID / Serial',
            '사용자별 예외: 특정 사용자에게만 USB 허용',
            '그룹별 예외: 특정 그룹에게 USB 허용',
            'USB 기기 로그: 연결/해제 이력 기록',
          ],
          notes: ['임직원별 USB 허용이 필요한 경우 그룹별 예외 설정'],
        },
      ],
    },
    {
      id: 'epp_syslog',
      title: '6. Syslog Data Sync 설정',
      description: 'Syslog를 통한 외부 SIEM/로그 서버로 데이터를 전송합니다.',
      steps: [
        {
          step: 1,
          title: 'Syslog 서버 설정',
          menuPath: 'System > Log Settings > Syslog',
          description: 'Syslog 서버 정보를 설정합니다.',
          details: [
            'Syslog Server IP: SIEM/로그 서버 IP 입력',
            'Syslog Server Port: 기본 514 (UDP) 또는 6514 (TCP/TLS)',
            'Protocol: UDP / TCP / TCP+TLS',
            'Log Format: Syslog (CEF) / Syslog (LEEF) / JSON',
            'Severity Mapping: EPP 이벤트 → Syslog Severity 매핑',
            'Buffer Size: 전송 버퍼 크기 설정',
          ],
        },
        {
          step: 2,
          title: '전송할 로그 유형 선택',
          menuPath: 'System > Log Settings > Syslog > Log Type',
          description: 'Syslog로 전송할 로그 유형을 선택합니다.',
          details: [
            'Detection Log: 악성코드 탐지 이벤트',
            'Behavior Log: 행위 기반 탐지 이벤트',
            'Device Control Log: USB/저장매체 이벤트',
            'App Control Log: 어플리케이션 제어 이벤트',
            'Agent Status Log: 에이전트 상태 변경 이벤트',
            'Audit Log: 관리자 감사 로그',
            'System Log: 시스템 이벤트 로그',
          ],
          notes: ['로그 유형은 운영 환경에 따라 선택적 전송 가능'],
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// IAG Setting Guide
// ═══════════════════════════════════════════════════════════════════════════════

export const IAG_SETTING_GUIDE: ProductSettingGuide = {
  product: 'IAG',
  productLabel: 'IAG (Internet Access Gateway)',
  version: 'v13.0.120',
  sections: [
    {
      id: 'iag_init',
      title: '1. 초기 설정',
      description: 'IAG 관리 콘솔 초기 설정 및 기본 네트워크 구성 절차를 안내합니다.',
      steps: [
        {
          step: 1,
          title: '관리 콘솔 접속',
          menuPath: 'Browser > https://<IAG_IP>',
          description: 'IAG 관리 콘솔에 로그인합니다.',
          details: [
            '기본 관리자 계정: admin',
            '초기 비밀번호는 제품 설치 시 설정한 값 사용',
            '로그인 후 관리자 비밀번호 변경 필수',
            'WebUI 인터페이스: Management Port (기본 443)',
          ],
        },
        {
          step: 2,
          title: '네트워크 인터페이스 설정',
          menuPath: 'System > General > Interfaces',
          description: '네트워크 인터페이스를 설정합니다.',
          details: [
            'Management Interface: 관리 전용 인터페이스 설정',
            'Data Interface: 트래픽 처리 인터페이스 설정',
            'Bypass Interface: 우회 인터페이스 설정 (장애 시)',
            'VLAN tagging: VLAN 태깅 설정',
            'IP 주소/서브넷마스크/게이트웨이 설정',
            'DNS 서버 설정',
          ],
        },
        {
          step: 3,
          title: '인증 서버 연결',
          menuPath: 'System > Authentication > Server',
          description: 'LDAP/ADIUS 인증 서버를 연결합니다.',
          details: [
            'LDAP Server: LDAP 서버 IP, 포트, Base DN 입력',
            'Bind DN: LDAP 바인딩 계정 정보',
            'ADIUS Server: RADIUS 서버 IP, 시크릿 키',
            '인증 서버 연결 테스트: Connection Test 버튼',
            '사용자/그룹 동기화: LDAP에서 사용자 그룹 가져오기',
          ],
          notes: ['인증 서버 연결 전 LDAP 바인딩 계정 권한 확인 필요'],
        },
        {
          step: 4,
          title: '정책 기본값 설정',
          menuPath: 'Policy > Access Control > Default Policy',
          description: '기본 접근 제어 정책을 설정합니다.',
          details: [
            'Default Action: Allow / Block / Authenticate',
            'Unauthenticated User Policy: 미인증 사용자 처리 방식',
            'User Group 정책: 그룹별 기본 접근 권한',
            'Logging Level: 로그 기록 수준 설정',
          ],
        },
      ],
    },
    {
      id: 'iag_dlp',
      title: '2. DLP 정책 설정',
      description: '데이터 유출 방지(DLP) 정책을 설정합니다.',
      steps: [
        {
          step: 1,
          title: 'DLP 정책 활성화',
          menuPath: 'Policy > DLP > Policies',
          description: 'DLP 정책을 활성화합니다.',
          details: [
            'DLP Policy: Enable',
            'Policy Scope: All Traffic / Specific User Groups',
            'Inspection Direction: Upload / Download / Both',
            'Protocol Coverage: HTTP / HTTPS / FTP / SMTP',
            'File Type Detection: 확장자 / MIME Type / 내용 분석',
          ],
        },
        {
          step: 2,
          title: '파일 유형별 탐지 설정',
          menuPath: 'Policy > DLP > File Type Rules',
          description: '파일 유형별 DLP 탐지 규칙을 설정합니다.',
          details: [
            'Office 파일 (docx, xlsx, pptx): 민감 문서 탐지',
            'PDF 파일: PDF 내 텍스트/이미지 분석',
            '이미지 파일 (jpg, png): OCR 기반 텍스트 탐지',
            '압축 파일 (zip, rar): 압축 해제 후 탐지',
            '소스 코드 파일 (java, py): 개발 자산 보호',
            '커스텀 규칙: 정규식 패턴 기반 탐지',
          ],
        },
        {
          step: 3,
          title: 'DLP 알림 및 로그 설정',
          menuPath: 'Policy > DLP > Alert & Log',
          description: 'DLP 탐지 시 알림 및 로그를 설정합니다.',
          details: [
            'Alert Action: Log / Notify / Block / Quarantine',
            'Notification: 이메일 / Syslog / Webhook 알림',
            'Log Detail Level: Summary / Full Detail',
            'Log Retention: 로그 보존 기간 설정',
            'Report: 정기 DLP 리포트 자동 생성',
          ],
          notes: ['Block 모드 적용 전 충분한 테스트 필요'],
        },
      ],
    },
    {
      id: 'iag_url_filtering',
      title: '3. URL Filtering 설정',
      description: 'URL 필터링 규칙을 설정하여 인터넷 접근을 제어합니다.',
      steps: [
        {
          step: 1,
          title: 'URL Filtering 활성화',
          menuPath: 'Policy > URL Filtering',
          description: 'URL 필터링을 활성화하고 카테고리별 차단 규칙을 설정합니다.',
          details: [
            'URL Filtering: Enable',
            'Category-based Filtering: 카테고리별 차단/허용',
            'Category List: Gambling, Malware, Social, Streaming 등',
            'Custom URL: 사용자 정의 URL 차단/허용',
            'Safe Search: Google/Bing Safe Search 강제',
            'SSL Inspection: HTTPS URL 검사 활성화',
          ],
        },
        {
          step: 2,
          title: '카테고리별 차단 규칙',
          menuPath: 'Policy > URL Filtering > Category Rules',
          description: '카테고리별 차단 규칙을 설정합니다.',
          details: [
            'High Risk: Malware, Phishing, C2 Server → Block',
            'Medium Risk: Gambling, Adult, weapons → Block',
            'Low Risk: Social Media, Streaming → Time-based Allow',
            'Business: Business-related Sites → Allow',
            'Unknown: 미분류 사이트 → Log / Alert',
          ],
        },
        {
          step: 3,
          title: '사용자 그룹별 적용',
          menuPath: 'Policy > URL Filtering > User Group Rules',
          description: '사용자 그룹별로 다른 URL 필터링 정책을 적용합니다.',
          details: [
            'Management Group: 제한 없는 접근 (감사 로그 포함)',
            'Employee Group: 비즈니스 관련 사이트만 허용',
            'Guest Group: 최소한의 인터넷 접근만 허용',
            'Time-based Policy: 업무 시간/비업무 시간 별도 정책',
            'Exception: 특정 사용자 예외 설정',
          ],
          notes: ['그룹 정책은 LDAP/AD 그룹과 연동하여 자동 적용 가능'],
        },
      ],
    },
    {
      id: 'iag_nac',
      title: '4. NAC (네트워크 접근 제어) 설정',
      description: '네트워크 접근 제어 정책을 설정합니다.',
      steps: [
        {
          step: 1,
          title: 'NAC 활성화',
          menuPath: 'Policy > NAC > Settings',
          description: 'NAC 모듈을 활성화합니다.',
          details: [
            'NAC: Enable',
            'Enforcement Mode: Monitor / Enforce',
            'Compliance Check: Endpoint Agent 상태 확인',
            'Quarantine VLAN: 미준수 기기 격리 VLAN 설정',
            'Redirect URL: 미준수 기기 리다이렉트 페이지',
          ],
        },
        {
          step: 2,
          title: '접근 제어 정책',
          menuPath: 'Policy > NAC > Access Policy',
          description: '네트워크 접근 제어 정책을 설정합니다.',
          details: [
            '802.1X 인증: 포트 기반 인증 활성화',
            'MAC Authentication: MAC 주소 기반 인증',
            'Agent-based: Endpoint Agent 상태 기반 접근',
            'Compliance Profile: 컴플라이언스 프로파일 설정',
            'Time-based Access: 시간 기반 접근 제어',
          ],
        },
      ],
    },
    {
      id: 'iag_activity_audit',
      title: '5. Activity Audit 로그 관리',
      description: '인터넷 접근 감사 로그를 관리합니다.',
      steps: [
        {
          step: 1,
          title: '감사 로그 활성화',
          menuPath: 'Activity Audit > Internet Access Audit',
          description: '인터넷 접근 감사 로그를 활성화합니다.',
          details: [
            'Internet Access Audit: Enable',
            'Log Fields: User, IP, URL, Category, Action, Time',
            'DNS Query Log: DNS 쿼리 기록',
            'Application Log: 애플리케이션 사용 로그',
            'Log Format: Text / JSON',
          ],
        },
        {
          step: 2,
          title: '로그 백업 및 내보내기',
          menuPath: 'Activity Audit > Log Export',
          description: '감사 로그를 외부로 백업/내보내기합니다.',
          details: [
            'Syslog Forwarding: Syslog 서버로 로그 전송',
            'Manual Export: CSV/PDF 로그 내보내기',
            'Scheduled Export: 정기 자동 내보내기',
            'Log Retention: 로그 보존 기간 설정 (최소 90일)',
            'Storage Management: 로그 저장 공간 관리',
          ],
        },
      ],
    },
    {
      id: 'iag_auth',
      title: '6. 인증 설정',
      description: 'ADIUS/LDAP/로컬 인증 설정을 구성합니다.',
      steps: [
        {
          step: 1,
          title: 'ADIUS 인증 설정',
          menuPath: 'System > Authentication > RADIUS',
          description: 'ADIUS 인증 서버를 설정합니다.',
          details: [
            'ADIUS Server IP/Port: RADIUS 서버 정보 입력',
            'Shared Secret: 공유 시크릿 키 설정',
            'Authentication Port: 1812 (기본)',
            'Accounting Port: 1813 (기본)',
            'Timeout: 인증 응답 대기 시간 (기본 5초)',
            'Retry: 재시도 횟수 (기본 3회)',
            'Test Connection: 연결 테스트',
          ],
        },
        {
          step: 2,
          title: 'LDAP 인증 설정',
          menuPath: 'System > Authentication > LDAP',
          description: 'LDAP 인증 서버를 설정합니다.',
          details: [
            'LDAP Server IP/Port: LDAP 서버 정보 입력',
            'Base DN: 검색 기본 DN',
            'Bind DN: 바인딩 계정 DN',
            'Bind Password: 바인딩 비밀번호',
            'User Filter: 사용자 검색 필터',
            'Group Filter: 그룹 검색 필터',
            'SSL/TLS: 암호화 통신 설정',
          ],
        },
        {
          step: 3,
          title: '로컬 인증 설정',
          menuPath: 'System > Authentication > Local',
          description: '로컬 사용자 인증을 설정합니다.',
          details: [
            'Local User: 로컬 사용자 계정 관리',
            'Password Policy: 비밀번호 복잡도 요구사항',
            'Session Timeout: 세션 타임아웃 설정',
            'MFA: 다因素 인증 설정 (TOTP/SMS)',
            'Break-glass Account: 비상 관리자 계정 관리',
          ],
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// Cyber Command (CC) Setting Guide
// ═══════════════════════════════════════════════════════════════════════════════

export const CC_SETTING_GUIDE: ProductSettingGuide = {
  product: 'CYBER_COMMAND',
  productLabel: 'Cyber Command (NDR)',
  version: 'v3.0.98C',
  sections: [
    {
      id: 'cc_init',
      title: '1. 초기 설정',
      description: 'Cyber Command 관리 콘솔 초기 설정 및 로그 수집 구성 절차를 안내합니다.',
      steps: [
        {
          step: 1,
          title: '관리 콘솔 접속',
          menuPath: 'Browser > https://<CC_IP>:8443',
          description: 'Cyber Command 관리 콘솔에 로그인합니다.',
          details: [
            '기본 관리자 계정: admin',
            '초기 비밀번호는 제품 설치 시 설정한 값 사용',
            '로그인 후 관리자 비밀번호 변경 필수',
            'Dashboard에서 전체 요약 확인 가능',
          ],
        },
        {
          step: 2,
          title: '로그 수집 시작',
          menuPath: 'Detection > Event Sources',
          description: '이벤트 소스를 설정하여 로그 수집을 시작합니다.',
          details: [
            'Event Source: Syslog / API / Agent 기반 수집',
            'Syslog Source: Syslog 서버 IP, 포트, 프로토콜 설정',
            'API Source: 외부 시스템 API 연동',
            'Agent Source: 에이전트 기반 수집',
            'Collector 설정: 로그 수집 에이전트 배포',
            'Time Synchronization: NTP 동기화 설정',
          ],
        },
        {
          step: 3,
          title: '대시보드 구성',
          menuPath: 'Dashboard > Configuration',
          description: '대시보드 위젯을 구성합니다.',
          details: [
            'Security Overview: 보안 요약 대시보드',
            'Incident Trend: 인시던트 추이 대시보드',
            'Top Threats: 주요 위협 대시보드',
            'Asset Inventory: 자산 목록 대시보드',
            'Custom Dashboard: 사용자 정의 대시보드',
            'Widget 설정: 데이터 소스, 필터, 표시 기간',
          ],
        },
      ],
    },
    {
      id: 'cc_threat_detection',
      title: '2. 위협 탐지 정책 설정',
      description: '위협 유형별 탐지 정책을 설정합니다.',
      steps: [
        {
          step: 1,
          title: '위협 탐지 정책 활성화',
          menuPath: 'Detection > Threats > Policy',
          description: '위협 탐지 정책을 활성화합니다.',
          details: [
            'Threat Detection: Enable',
            'Detection Engine: Signature / Anomaly / ML',
            'Threat Types: Malware, C2, Lateral Movement, Exfiltration',
            'Severity Mapping: Critical / High / Medium / Low',
            'Auto-Enrichment: 위협 인텔리전스 자동 조회',
          ],
        },
        {
          step: 2,
          title: '위협 유형별 대응 설정',
          menuPath: 'Detection > Threats > Response',
          description: '위협 유형별 자동 대응을 설정합니다.',
          details: [
            'Malware: 격리, 네트워크 차단, 알림',
            'C2 Communication: 연결 차단, IP 차단',
            'Lateral Movement: 세그먼트 격리',
            'Data Exfiltration: 트래픽 차단, 알림',
            'Insider Threat: 사용자 격리, 관리자 알림',
          ],
        },
      ],
    },
    {
      id: 'cc_ueba',
      title: '3. UEBA 이상 탐지 설정',
      description: '사용자 및 엔드포인트 행위 분석(UEBA) 이상 탐지를 설정합니다.',
      steps: [
        {
          step: 1,
          title: 'UEBA 활성화',
          menuPath: 'Detection > Anomalies > UEBA',
          description: 'UEBA 모듈을 활성화합니다.',
          details: [
            'UEBA: Enable',
            'Baseline Period: 기준선 구축 기간 (최소 30일)',
            'Anomaly Types: Login, Access, Data Transfer, Time',
            'Sensitivity Level: Low / Medium / High',
            'User Profiling: 사용자 프로파일 자동 구축',
          ],
        },
        {
          step: 2,
          title: '이상 탐지 규칙 설정',
          menuPath: 'Detection > Anomalies > Rules',
          description: '이상 탐지 규칙을 설정합니다.',
          details: [
            'Login Anomaly: 비정상 로그인 패턴 탐지',
            'Access Anomaly: 비정상 접근 패턴 탐지',
            'Data Transfer Anomaly: 비정상 데이터 전송 탐지',
            'Time Anomaly: 비정상 시간대 활동 탐지',
            'Peer Group Analysis: 동일 그룹 내 이상 행동 탐지',
          ],
        },
      ],
    },
    {
      id: 'cc_log_collection',
      title: '4. 로그 수집 설정',
      description: '이벤트 소스별 로그 수집을 설정합니다.',
      steps: [
        {
          step: 1,
          title: '이벤트 소스 설정',
          menuPath: 'Detection > Event Sources > Configuration',
          description: '이벤트 소스를 설정합니다.',
          details: [
            'NGAF: Sangfor NGAF 로그 연동',
            'IAG: Sangfor IAG 로그 연동',
            'Endpoint: Sangfor Endpoint Secure 로그 연동',
            'Third-party: 타사 시스템 Syslog/API 연동',
            'Collector: 로그 수집 에이전트 배포',
          ],
        },
        {
          step: 2,
          title: '로그 필터링 설정',
          menuPath: 'Detection > Event Sources > Filter',
          description: '수집할 로그 필터를 설정합니다.',
          details: [
            'Include Filter: 수집할 로그 유형 지정',
            'Exclude Filter: 제외할 로그 유형 지정',
            'Severity Filter: 심각도별 필터링',
            'Source Filter: 소스별 필터링',
            'Rate Limit: 수집 속도 제한',
          ],
        },
      ],
    },
    {
      id: 'cc_soar',
      title: '5. SOAR 자동 대응 플레이북',
      description: 'SOAR 자동 대응 플레이북을 설정합니다.',
      steps: [
        {
          step: 1,
          title: '플레이북 생성',
          menuPath: 'Response > SOAR > Playbooks',
          description: '자동 대응 플레이북을 생성합니다.',
          details: [
            'Playbook Name: 직관적인 이름 설정',
            'Trigger: 인시던트/알림 발생 시 트리거',
            'Actions: 자동 대응 작업 목록',
            'Conditions: 조건부 실행 로직',
            'Approval: 승인 필요 여부 설정',
          ],
        },
        {
          step: 2,
          title: '플레이북 실행 설정',
          menuPath: 'Response > SOAR > Playbooks > Execution',
          description: '플레이북 실행 옵션을 설정합니다.',
          details: [
            'Auto-Execute: 자동 실행 활성화',
            'Manual Approval: 수동 승인 후 실행',
            'Execution Log: 실행 이력 기록',
            'Rollback: 실행 취소/ 롤백 기능',
            'Test Mode: 테스트 모드로 검증',
          ],
          notes: ['중요한 대응 작업은 Manual Approval 모드 권장'],
        },
      ],
    },
    {
      id: 'cc_alerts',
      title: '6. 알림 채널 설정',
      description: '이메일/SMS/Syslog 알림 채널을 설정합니다.',
      steps: [
        {
          step: 1,
          title: '이메일 알림 설정',
          menuPath: 'Settings > Notification > Email',
          description: '이메일 알림 채널을 설정합니다.',
          details: [
            'SMTP Server: SMTP 서버 정보 입력',
            'From Address: 발신자 이메일 주소',
            'To Address: 수신자 이메일 목록',
            'Alert Level: 이메일 알림을 받을 심각도 수준',
            'Alert Types: 이메일로 알림을 받을 이벤트 유형',
          ],
        },
        {
          step: 2,
          title: 'SMS 알림 설정',
          menuPath: 'Settings > Notification > SMS',
          description: 'SMS 알림 채널을 설정합니다.',
          details: [
            'SMS Gateway: SMS 게이트웨이 정보 입력',
            'Phone Number: 수신자 전화번호',
            'Alert Level: SMS 알림을 받을 심각도 수준 (Critical만 권장)',
            'Rate Limit: 알림 빈도 제한',
          ],
        },
        {
          step: 3,
          title: 'Syslog 알림 설정',
          menuPath: 'Settings > Notification > Syslog',
          description: 'Syslog로 알림을 전송합니다.',
          details: [
            'Syslog Server: Syslog 서버 IP, 포트',
            'Protocol: UDP / TCP / TCP+TLS',
            'Format: CEF / JSON / LEEF',
            'Alert Types: Syslog로 전송할 이벤트 유형',
          ],
        },
      ],
    },
  ],
};

export function getProductSettingGuide(product: string): ProductSettingGuide | undefined {
  const normalized = product.toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'ENDPOINT_SECURE' || normalized === 'EPP') return EPP_SETTING_GUIDE;
  if (normalized === 'IAG') return IAG_SETTING_GUIDE;
  if (normalized === 'CYBER_COMMAND' || normalized === 'NDR' || normalized === 'CC') return CC_SETTING_GUIDE;
  return undefined;
}

export function getAllProductSettingGuides(): ProductSettingGuide[] {
  return [EPP_SETTING_GUIDE, IAG_SETTING_GUIDE, CC_SETTING_GUIDE];
}
