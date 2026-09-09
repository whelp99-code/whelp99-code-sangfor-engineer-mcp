# 5차 개선 평가 자료

계획·진행 상태는 [5차 개선안](../../design-docs/revision-v5-independent-quality-rollout.md)을 따른다. 현재 자료는 최종 완료 보고가 아니다.

- `holdout-manifest.json`: 변경 전에 고정한 12개 정상/12개 무응답 질문, 인용 원문 위치와 해시. 결과를 아직 개선에 사용하지 않았다.
- `subject-*`, `structured-*`, `field-*`: 기존 21문항 및 노출된 개발 12문항 실험. settings/index/implementation SHA가 다른 실험을 같은 설정 게이트 통과로 해석하지 않는다.
- `mcp-development-context.json`: 실제 stdio MCP 캡처. 검색 5개 문서와 제한된 이웃 청크가 포함된다. 고객 운영 상태가 아니라 문서 코퍼스 응답이다.
- `client-development-answers.json`: 위 응답만 근거로 현재 Codex 클라이언트가 작성한 답변과 정확한 인용. 외부 모델이나 독립 사람 검수 결과가 아니다.
- `client-development-evidence-eval.json`: `pnpm run rag:eval:answers docs/references/revision-v5/mcp-development-context.json docs/references/revision-v5/client-development-answers.json`으로 재현. 인용·제품·버전 무결성과 답변의 의미적 정확성은 구분한다.
- `plan-development.json`: 실제 구성 계획 템플릿의 인용 검증 결과. 구조적으로 완전해도 검증된 Q&A 답변이 아니다.

큰 후보 인덱스·모델 가중치·체크포인트는 `.omo/revision-v5`에 보관하며 커밋하지 않는다. 운영 승격/실행 승인을 이 자료에서 추론하면 안 된다.

MiniLM 동일 코퍼스 개발 비교는 `minilm-{dense,hybrid,rrf}-{original,development}.json`에 기록했다. `minilm-hybrid-korean*.json`은 기존 개발 질문의 한국어 번역 실험이며 독립 holdout이 아니다. 주제 일치 조건은 한국어 적중률과 무응답 오탐 사이의 미해결 문제를 보였으므로 최종 채택으로 해석하지 않는다.
