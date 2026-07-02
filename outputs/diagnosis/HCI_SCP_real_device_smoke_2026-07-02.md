# HCI/SCP 실장비 read-only 스모크 증적 — 2026-07-02

> 전 과정 read-only. AI는 어떤 장비 설정도 변경하지 않았습니다. (M4 스파이크)

## 접속
- OpenAPI(Keystone v2) 호스트: **SCP 10.80.1.104:4430** (HCI 10.80.1.105의 keystone은 401 — .105는 OpenAPI 호스트 아님)
- 인증: `admin` / (env), Keystone v2 passwordCredentials → **200 + serviceCatalog** (tenantName 없이 'admin' 프로젝트 자동 스코프)

## 인증 계약 검증 결과 = VERIFIED
`KeystoneV2TokenProvider` 계약(`access.token.id`, `access.token.tenant.id`, `access.token.expires`, `serviceCatalog[].endpoints[0].publicURL`)이 실장비 응답과 **정확 일치**. `HCI_AUTH_CONTRACT_STATUS = verified_on_10.80.1.104_2026-07-02`.

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

재현: `SANGFOR_HCI_IDENTITY_URL=... SANGFOR_HCI_USER=... SANGFOR_HCI_PASSWORD=... pnpm exec tsx scripts/hci-real-smoke.ts` (VPN 연결 시).
