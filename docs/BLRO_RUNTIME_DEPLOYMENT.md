# BLRO 내부 운영 배포 기록 — 2026-09-09

추적: [Issue #88](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/88).
사용자가 보류했던 운영 설정과 실제 배포를 승인하여 신규 전용 환경을 구성하고 기존 SSH MCP 진입점에 적용했다.
이 기록은 현재 설치 상태를 설명한다. 전체 제품의 고객 운영·장비 변경·고가용성 구축 완료를 의미하지 않는다.

## 접속

- JM PC의 운영 콘솔: <http://127.0.0.1:13502/>.
- 콘솔 토큰 입력란에 `/home/jm/.config/sangfor-blro/api-token.txt`의 값을 입력하고 저장한다. 토큰을 채팅이나 이슈에 붙이지 않는다.
- 준비 상태: <http://127.0.0.1:13700/ready>.
- JM의 `sangfor-blro-console-tunnel.service`가 SSH 연결을 유지하고 재연결한다. 두 주소는 이 PC에서만 접근한다.
- 기존 `/home/blro/orca/projects/sangfor-engineer-mcp/start-mcp.sh`도 새 설정으로 활성화됐다. 이미 연결된 MCP 클라이언트는 재연결해야 새 프로세스를 사용한다.

## 설치 구성

BLRO 호스트는 `blro01`, 프로젝트 루트는 `/home/blro/orca/projects/sangfor-engineer-mcp`이다.
설정·비밀·데이터·실행 래퍼·백업은 루트 아래 `runtime`에 분리했다. 디렉터리는 0700, 비밀 파일은 0600이다.
클라우드 비밀 관리 서비스 대신 해당 계정의 비공개 파일을 사용한다.

| 구성 | 실제 설치 |
| --- | --- |
| 실행 릴리스 | `releases/f630655`; `current`도 이 경로를 가리킴 |
| 소스 아카이브 SHA-256 | `7401eca8536a3b74283c7d290e32c526795f478bb7c27b337f74a4bd9fca6644` |
| 기준 main | `cd8e44db41b8fcd7aad4d6c052c3dd008c1e27d4`; 이전 검증에서 실행 소스 일치 확인. 릴리스 디렉터리 자체가 이 Git 커밋 체크아웃이라는 뜻은 아님 |
| 공개 문서 검색 | `runtime/data/rag-index.json`, 39,789개 청크; 검증된 파일 기반 검색 유지 |
| 인덱스 SHA-256 | `ff1118e44d4c1f21e7e465f6e1d66fcb0f4a08a09e9f1f7fbc098054c3febfa0` |
| 임베딩 | multilingual-e5-small, 384차원, revision `614241f622f53c4eeff9890bdc4f31cfecc418b3` |
| 재순위화 | Qwen3-Reranker-0.6B, revision `e61197ed45024b0ed8a2d74b80b4d909f1255473` |
| DB | 전용 PostgreSQL 16 + pgvector 0.8.1, `127.0.0.1:55432`, DB `blro` |
| 컨테이너 / 볼륨 | `sangfor-blro-postgres` / `sangfor-blro-postgres16-data` |
| DB 이미지 | `pgvector/pgvector@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337` |

Control Tower만 PostgreSQL 권한 저장소를 사용한다. 공개 검색 인덱스를 PostgreSQL로 이관한 것은 아니다.
새 내부 tenant `jm`, project `sangfor-engineer`, actor `blro-service`와 빈 권한 목록의 서비스 역할을 만들었다.
기존 고객 신원으로 가장하거나 고객 장비를 등록하지 않았다. DB owner/app/backup 역할과 비밀번호를 분리했고 앱은 RLS를 우회하지 못한다.
백업 역할만 전체 읽기용 BYPASSRLS를 가진다.

내부 Ed25519 서명 키, 내부 CA, 독립된 승인·감사 비밀을 생성했다. 고객 endpoint 등록이나 공개 인증서 발급을 완료한 상태는 아니다.
실제 장비 실행·운영 실행·원격 쓰기 허용 값은 모두 false다. LightRAG는 도입하지 않았다.

## 프로세스 관리

BLRO 사용자 systemd에서 아래 서비스가 enabled/active이며 실패 시 재시작한다. 사용자 linger도 활성화돼 있다.

| 사용자 서비스 | BLRO loopback 포트 |
| --- | --- |
| `sangfor-embedding` | 8114 |
| `sangfor-reranker` | 8119 |
| `sangfor-bridge` | 3600 |
| `sangfor-console` | 3502 |
| `sangfor-tower` | 3700 |

상태 확인은 BLRO에서 `systemctl --user status <서비스>`와 `journalctl --user -u <서비스>`를 사용한다.
DB 컨테이너는 `unless-stopped`로 복구한다. 앱 실행 래퍼는 `runtime/bin/launch-app.py`이며 현재 릴리스 경로를 명시적으로 고정한다.
`current` 링크만 바꾸어서는 업그레이드되지 않는다.
모델 Python 환경은 `releases/26b3a5e/.venv-embed`를 재사용하므로 이전 릴리스 정리 시 삭제하면 안 된다.

## 검증 결과

- DB migration deploy 성공; schema `20260826220000_blro_remote_job_authority`.
- 실제 앱 DB 계정으로 `node scripts/verify-rls-isolation.mjs --require`: 39개 테이블, 659개 격리 검증 통과.
- DB와 5개 서비스를 재시작한 뒤 모델 health, bridge health, 콘솔 HTML 및 Tower의 8개 readiness 항목 모두 통과.
- 실제 SSH MCP 진입점의 대표 4문항: 기존 검증 결과와 검색 ID 및 순서 일치. 정답 문서가 있는 HCI/NGFW 2문항과 답변을 보류해야 하는 2문항 포함.
- 토큰 없는 보호 API 요청은 401. JM SSH 터널을 통한 콘솔과 readiness는 HTTP 200.
- 기존 릴리스 검증: 3,332 tests passed / 102 skipped, lint/build, 118개 MCP 도구 smoke, browser boundary, scorecard 96. 이번 설정 배포에서 전체 테스트나 전체 24문항을 다시 실행했다는 의미는 아니다.
- 신규 DB 백업은 61개 테이블을 별도 scratch DB에 복원·비교한 후 `BLRO_BACKUP_PUBLISHED`. 이는 전체 장애 복구 정책과 수동 승격 훈련을 완료했다는 의미는 아니다.

재시작 및 검색의 비밀 없는 근거는 `references/blro-runtime-rollout/`에 보관한다.

## 백업과 복구

`sangfor-backup.timer`는 매일 18:30 UTC, 즉 한국 시간 다음 날 03:30에 `sangfor-backup.service`를 실행한다.
해당 서비스는 `runtime/bin/backup.mjs`에서 저장소의 `runBackup`을 호출한다. 자격 증명은 비공개 파일에서 메모리로 읽는다.
수동 백업은 BLRO에서 `systemctl --user start sangfor-backup.service`로 실행하고 journal의 발행 성공을 확인한다.

배포 시 발행한 백업 ID는 `blro-runtime-20260909100616225`, dump SHA-256은
`6c156349defb48056a83b29878d92348103c2e1146a99994f311965d7e45d058`이다.
DB dump·서명 manifest와 별도로 설정·키·래퍼의 암호화 복구 묶음을 만들고 복호화 일치를 검증했다.
JM에 복사한 암호문의 해시와 Ed25519 서명도 확인했다.

- BLRO 백업: `runtime/backups`.
- JM 복사본: `/home/jm/.local/share/sangfor-blro/recovery`.
- JM 복구 키: `/home/jm/.config/sangfor-blro/recovery-encryption.key`.
- 비밀과 DB dump는 Git에 넣지 않는다.

복구 시 먼저 쓰기를 차단한 채 서명·해시를 검증하고 별도 scratch 환경에 복원한다.
[기존 복구 정책](BLRO_OPERATIONS_RUNBOOK.md#55-recovery-policy--applied-only-in-scratch-after-equality)에 따라 epoch·승인·nonce·감사 상태를 처리하고 결과를 확인한 뒤 사람이 승격한다.
이전 진입점 원본은 `runtime/backups/start-mcp.before-rollout.sh`에 보존했다. 이를 되돌리는 것만으로 DB나 승인 상태까지 복구되지는 않는다.

## 남은 운영 한계

- 단일 호스트 설치다. WAL 보관·동기 복제·자동 장애 전환은 구성하지 않았으며 데이터 무손실 복구를 보장하지 않는다.
- 일일 백업은 서버 내 저장이다. JM 복사본은 이번 배포 시점의 1회 복사이며 자동 원격 복제는 아니다.
- 자동 보존 기간 정리, 디스크 용량 경보, 외부 장애 알림은 추가 운영 과제다.
- 암호화 설정 묶음은 해당 시점 스냅샷이다. 설정 변경 후 갱신해야 하며 systemd unit은 별도 보존해야 한다.
- 초기 버전 확인 중 생성한 비어 있는 PG17 컨테이너는 `sangfor-blro-postgres-uninitialized-pg17`로 중지·보존했다. 운영 DB가 아니다.
- 모델의 이전 검증 프로세스 및 환경은 보존했다. 현재 서비스는 8114/8119를 사용한다.
- 호스트 전체 재부팅 시험은 하지 않았다. DB·서비스 재시작 및 자동 시작 설정을 확인했다.
