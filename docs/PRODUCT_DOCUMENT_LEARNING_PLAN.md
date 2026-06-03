# 제품 문서 학습 우선순위

## 기본 원칙

문서 학습은 모델 파인튜닝이 아니라 `문서 수집 -> 버전/출처 메타데이터 -> chunking -> 검색/RAG -> 구성 템플릿 반영 -> eval case` 순서로 진행한다.

## 1순위: HCI

학습 우선 문서:

1. HCI Installation / Deployment Guide
2. HCI User Manual / Admin Guide
3. HCI Networking Guide
4. HCI Storage / Virtual Storage Guide
5. VM Migration / P2V / V2V Guide
6. DR / Backup / HA / Failover 관련 가이드
7. Troubleshooting Guide
8. Release Notes / Known Issues

우선 추출할 지식:

- 클러스터 초기 구성 절차
- 관리망/스토리지망/VM망 구성 기준
- MTU/VLAN/NIC mapping precheck
- 스토리지 풀 생성/검증 기준
- VM 이관/DR 사전 점검
- 롤백 기준
- 검증 체크리스트

## 2순위: IAG

학습 우선 문서:

1. IAG Deployment Guide
2. IAG User/Policy Admin Guide
3. Authentication / AD / LDAP Integration Guide
4. URL/Application Control Policy Guide
5. Logging / Audit / Report Guide
6. High Availability / Backup / Restore Guide
7. Troubleshooting Guide
8. Release Notes / Known Issues

우선 추출할 지식:

- 사용자/그룹 정책 구조
- 인증 연동 방식
- 인터넷 접근제어 정책 순서
- 예외 정책/긴급 우회 정책
- 정책 적용 전 export/rollback
- 로그 검증

## 3순위: Endpoint Secure

학습 우선 문서:

1. Endpoint Secure Deployment Guide
2. Management Console Admin Guide
3. Agent Installation Guide
4. Policy Configuration Guide
5. EPP/EDR Detection and Response Guide
6. Exception / Whitelist Guide
7. Update / Patch / Version Compatibility Guide
8. Troubleshooting Guide

우선 추출할 지식:

- agent 배포 방식
- pilot group rollout
- OS/agent 호환성
- AV/EDR 정책 baseline
- 예외 정책
- rollback/uninstall 절차
- 탐지/차단 검증

## 4순위: Cyber Command

학습 우선 문서:

1. Cyber Command Deployment Guide
2. Event Source Integration Guide
3. Collector / Log Ingestion Guide
4. Alert Rule / Correlation Policy Guide
5. Dashboard / Report Guide
6. Integration Guide with Endpoint Secure/IAG/NGAF/HCI
7. Troubleshooting Guide
8. Release Notes / Known Issues

우선 추출할 지식:

- 이벤트 소스 온보딩
- collector 구성
- NTP/timezone 검증
- alert rule 설계
- dashboard/report 구성
- 보안 이벤트 검증

## 문서 신뢰도 정책

- official: Sangfor 공식 매뉴얼/지원 포털/공식 릴리스 노트
- internal: 내부 위키/검증 완료 문서
- draft: 작성 중 문서
- needs_review: 출처 불명확 또는 검토 전 자료

구성 계획 생성 시 우선순위:

1. official same-version manual
2. internal approved wiki
3. lessons learned
4. config pattern
5. draft/needs_review는 참고만 하고 자동 반영 금지

## 학습 완료 기준

제품별로 아래가 채워지면 1차 학습 완료로 본다.

- 설치/배포 절차
- 주요 설정 항목
- 사전 점검
- 위험 작업 목록
- 롤백 절차
- 검증 항목
- 장애/주의사항
- 버전별 차이
- 반복 피드백 기반 eval case
