# HCI/SCP 실장비 read-only 스모크 증적 — 2026-07-02

> 전 과정 read-only. AI는 어떤 장비 설정도 변경하지 않았습니다. (M4 스파이크)
> E02: 이 기록의 호스트·계정 원문은 자리표시자로 바꿨다. 값은 재사용하지 않는다. 현재 파일 정리만으로 유출 대응 완료가 아니다.

## 접속
- OpenAPI(Keystone v2) 호스트: 승인된 `SANGFOR_HCI_IDENTITY_URL` (HCI 콘솔 호스트의 keystone은 이 기록에서 401 — 콘솔 호스트는 OpenAPI 호스트가 아님)
- 인증: `SANGFOR_HCI_USER`와 `SANGFOR_HCI_PASSWORD`(환경 변수만), Keystone v2 passwordCredentials → **200 + serviceCatalog** (tenantName 없이 기본 프로젝트 자동 스코프)

## 인증 계약 검증 결과 = VERIFIED
`KeystoneV2TokenProvider` 계약(`access.token.id`, `access.token.tenant.id`, `access.token.expires`, `serviceCatalog[].endpoints[0].publicURL`)이 실장비 응답과 **정확 일치**. `HCI_AUTH_CONTRACT_STATUS`는 당시 호스트 스탬프를 client 소스에 남긴 역사 기록이다. 이 증적 파일에는 호스트를 반복하지 않는다.

## 계약 드리프트 (수정 완료)
- 볼륨 서비스 catalog `type = "volumev2"` (name cinderv2), 문서/코드는 'volume' 사용 → client가 `'volume'→['volumev2','volume']` 해석하도록 수정, mock도 volumev2로 정합.

## 서비스 가용성 (fixed 클라이언트 경유 collectInventory)
```
servers=28 images=0 volumes=0 volumeServiceAvailable=false
```
- **compute (nova): 200** — 실 VM 28대 조회됨 (read-only)
- **image (glance): 200** — 이미지 0
- **volume (cinder/volumev2): 503** — "publicURL endpoint for volumev2 service not found" (이 SCP에 cinder 백엔드 미배포). `collectInventory`가 crash 없이 `volumeServiceAvailable=false`로 관대 처리.

## 결론
- ✅ 인증 계약 검증 + read-only 인벤토리/헬스 리포트 실장비 동작 확인.
- ⛔ **create-volume 실장비 field_verified 불가**: volume 서비스 503(미배포). + write 가능한 유일 서비스(compute)는 실 프로덕션 VM 대상 → **이번 세션 실장비 write 없음, read-only만** (안전·정직).
- create-volume capability는 `tested_mock` 유지. volume 서비스가 배포된 SCP를 확보하면 그때 field_verified 승격.

재현: 승인된 저장소에서 `SANGFOR_HCI_IDENTITY_URL`, `SANGFOR_HCI_USER`, `SANGFOR_HCI_PASSWORD`를 주입한 뒤 `pnpm exec tsx scripts/hci-real-smoke.ts` (VPN 연결 시). 과거 문서 값은 쓰지 않는다.
