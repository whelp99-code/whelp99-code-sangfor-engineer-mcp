# Sangfor Excel 설정 Dry-run 계획서

- Plan ID: excel_plan_1780587377099_1603fa
- Summary: Generated Excel-driven dry-run plan for 26 checklist row(s); 12 mapped to Sangfor product consoles.
- Scope: 계획 생성 + Playwright dry-run 증적 수집. 실제 Save/Apply/Delete는 차단.

## 제품 콘솔 Dry-run 대상

| 요청 | 제품 | 메뉴 | 설정 | 설명 | 현재 Gap | 증적 | 승인 |
|---|---|---|---|---|---|---|---|
| REQ-4 | ENDPOINT_SECURE | Policy > Malware/Ransomware Protection | Malware/ransomware protection policy check | Anti-Virus / ③Malware Infection Prevention / 바이러스 백신 엔진은 정기적으로 업데이트됩니까? | No regular engine update verification procedure | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence, endpoint agent inventory and update status | 필요 |
| REQ-5 | ENDPOINT_SECURE | Policy > Malware/Ransomware Protection | Malware/ransomware protection policy check | Anti-Virus / ③Malware Infection Prevention / 바이러스 백신 및 EDR 솔루션을 사용하여 주기적인 검사가 수행됩니까? | Scan scheduled at lunch daily | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence, endpoint agent inventory and update status | 필요 |
| REQ-6 | ENDPOINT_SECURE | Policy > Malware/Ransomware Protection | Malware/ransomware protection policy check | Anti-Virus / ③Malware Infection Prevention / 바이러스 백신 및 EDR 프로그램이 임의로 제거되거나 비활성화되지 않도록 보장됩니까? | No explicit gap text; verify checklist result and current console state. | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence, endpoint agent inventory and update status | 필요 |
| REQ-8 | ENDPOINT_SECURE | Policy > Malware/Ransomware Protection | Malware/ransomware protection policy check | Software Control / ③Malware Infection Prevention / 조직 내에서 승인되지 않은 소프트웨어 사용은 감시 및 통제되고 있습니까? | No application control or monitoring | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence | 필요 |
| REQ-9 | ENDPOINT_SECURE | Policy > Malware/Ransomware Protection | Malware/ransomware protection policy check | Software Control / ⑦Incident Analysis and Response / 무단 소프트웨어 탐지/차단 로그 및 감사 로그(정책 변경, 권한 변경 등)는 지정된 기간(최소 1년) 동안 보관됩니까? | No application control or monitoring | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence, incident/alert/playbook evidence | 필요 |
| REQ-10 | ENDPOINT_SECURE | Policy > Malware/Ransomware Protection | Malware/ransomware protection policy check | Device Control / ⑤Information Leakage Prevention / 조직 내 저장 매체 사용은 통제되고 있습니까? | No device control or monitoring (Only automatic scans) | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence | 필요 |
| REQ-11 | ENDPOINT_SECURE | Policy > Malware/Ransomware Protection | Malware/ransomware protection policy check | Device Control / ⑦Incident Analysis and Response / 저장 매체 차단/사용 로그 및 감사 로그(정책 변경, 권한 변경 등)는 지정된 기간(최소 1년) 동안 보존됩니까? | No device control or monitoring (Only automatic scans) | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence, incident/alert/playbook evidence | 필요 |
| REQ-14 | IAG | Policy > Access Control | Internet/URL/application access policy check | Network Access Contro / ②Unauthorized External Access Defense / 조직 내에서 승인되지 않은 장치의 접근을 제한하기 위해 네트워크 접근 제어가 시행되고 있습니까? | No NAC implemented | current setting screenshot, audit/checklist row reference, before/after comparison candidate, policy/auth configuration screenshot | 필요 |
| REQ-15 | IAG | Policy > Access Control | Internet/URL/application access policy check | Network Access Contro / ②Unauthorized External Access Defense / 보안 프로그램 설치가 필수이며, 해당 프로그램이 설치되지 않은 경우 네트워크 접속이 차단됩니까? | No NAC implemented | current setting screenshot, audit/checklist row reference, before/after comparison candidate, policy/auth configuration screenshot | 필요 |
| REQ-16 | IAG | Logs > Internet Access Logs | Log retention and audit validation | Network Access Contro / ⑦Incident Analysis and Response / 이벤트 로그와 감사 로그는 지정된 기간(최소 1년) 동안 보존됩니까? | No NAC implemented | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence, incident/alert/playbook evidence | 불필요 |
| REQ-17 | NDR | Events > Event Sources | Event source/sensor integration check | Log Management / ①Intrusion Threat Detection / 다양한 보안 솔루션의 이벤트 로그와 감사 로그는 중앙에서 관리됩니까? | No SIEM implemented but Auvik collects network logs | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence, endpoint agent inventory and update status | 불필요 |
| REQ-18 | NDR | Events > Event Sources | Event source/sensor integration check | Log Management / ①Intrusion Threat Detection / 시스템 및 보안 로그는 정기적으로 검토됩니까? | No regular monitoring - only by events. No events are assigned so appears as no one is actually reviewing them | current setting screenshot, audit/checklist row reference, before/after comparison candidate, log retention/export evidence | 불필요 |

## 수동/외부 증적 대상

| 요청 | 항목 | 설명 | 현재 Gap | 필요한 조치 |
|---|---|---|---|---|
| REQ-1 | Anti-Spam | Anti-Spam / ③Malware Infection Prevention / 스팸 메일과 바이러스에 감염된 이메일이 내부 네트워크로 유입되는 것을 차단하는 정책이 마련되어 있습니까? | Using SPAMOUT email filtering system, but controlled by HQ. No control over the tool | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-2 | Anti-Spam | Anti-Spam / ⑦Incident Analysis and Response / 이벤트 로그와 감사 로그는 지정된 기간(최소 1년) 동안 보존됩니까? | Logs retained for less than 1 year | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-3 | Anti-Virus | Anti-Virus / ③Malware Infection Prevention / 조직 내 모든 PC와 서버에 안티바이러스 및 EDR과 같은 악성코드 탐지 솔루션이 설치되어 실행 중입니까? | Using Crowdstrike and Alyac Need additional evidence to see the list of assets and the installation status (Alyac and Crowdstrike) | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-7 | Anti-Virus | Anti-Virus / ⑦Incident Analysis and Response / 악성코드 탐지 로그와 격리된 파일은 지정된 기간(최소 1년) 동안 보관됩니까? | No files are retained, only logs are searchable through crowdstrike console. Also, need a verification from Alyac | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-12 | Data Loss Prevention | Data Loss Prevention / ⑤Information Leakage Prevention / 내부 데이터의 외부 유출을 감지하기 위해 데이터 손실 방지(DLP) 시스템이 구현되어 있습니까? | No DLP implemented | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-13 | Data Loss Prevention | Data Loss Prevention / ⑦Incident Analysis and Response / 대용량 첨부 파일(예: 50MB 이상) 전송 기록은 지정된 기간(최소 1년) 동안 보관됩니까? | No DLP implemented | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-19 | Security Monitoring | Security Monitoring / ①Intrusion Threat Detection / 보안 시스템 로그(예: 방화벽, VPN, IPS, WAF)가 보안 모니터링과 통합되어 있습니까? | No network security logs are actively monitored Crowdstrike is monitored by Packetwatch | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-20 | Security Monitoring | Security Monitoring / ①Intrusion Threat Detection / 이상 징후 탐지 기준이 설정되어 있고, 이상 징후가 감지되는 즉시 관리자에게 이메일이나 SMS로 알림을 보내는 경보 시스템이 구성되어 있습니까? | Only alert from Crowdstrike is sent out to ITAC | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-21 | Backup Management | Backup Management / ⑥System Recovery / 복구 우선순위와 복구 목표가 수립되었습니까? | Outdated | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-22 | Backup Management | Backup Management / ⑥System Recovery / 핵심 애플리케이션, 데이터베이스 및 중요 파일은 매일 또는 정기적으로 백업됩니까? | Biweekly backups | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-23 | Backup Management | Backup Management / ⑥System Recovery / 백업 데이터의 무결성은 정기적으로 검증됩니까? | Backup done monthly | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-24 | Backup Management | Backup Management / ⑥System Recovery / 백업 데이터는 안전한 저장소에 저장됩니까? | Stored on offline servers | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-27 | Backup Management | Backup Management / ⑥System Recovery / 백업 및 복구 테스트는 정기적으로 계획되고 실행됩니까? | Backups tested monthly, but recovery not tested | Do not access Sangfor console. Collect external/manual evidence and attach to review. |
| REQ-28 | Backup Management | Backup Management / ⑥System Recovery / 보안 솔루션 구성 및 보안 정책은 정기적으로 백업됩니까? | Only firewall config is backed up | Do not access Sangfor console. Collect external/manual evidence and attach to review. |

## 실행 게이트

- sessionId is required for Playwright console dry-run.
- Local Chrome must expose a CDP endpoint for existing-browser operation.
- Dry-run may navigate and collect screenshots, but must not click Save/Apply/Delete or execute response actions.
- Rows mapped to external_or_manual are reported for manual/non-Sangfor handling.

## 차단 동작

- Save
- Apply
- Delete
- Commit
- Policy Enable
- Agent Deployment
- SOAR Response Action
