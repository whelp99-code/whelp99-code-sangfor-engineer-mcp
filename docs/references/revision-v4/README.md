# 후속 개선 검증 자료

[실행 계획과 결론](../../design-docs/revision-v4-semantic-validation.md)을 참조한다. `comparison.json`은 원시 결과를 그대로 요약하며, 각 보고서에 입력·코드·설정 SHA와 개별 질문 결과가 있다. original은 21문항, validation은 이미 노출된 개발 회귀 12문항이다. 무응답은 각각 별도 4문항이다.

`corpus-readback.json`은 66,767청크 전체 검증과 3개 실제 모델 재계산 결과다. 큰 후보 인덱스와 모델 가중치는 커밋하지 않았다. 후보는 작업 공간 `.omo/revision-v4/corpus-minilm.json`에 있다. `runtime-probes.json`과 `python-runtime.json`은 로컬 검증 서비스 기록이다. 모델 처리량 probe는 동시 부하의 단일 측정으로 SLO가 아니다.

재현: `automation/embedding-server/README.md`의 고정 모델/revision 서버를 시작하고 `pnpm run rag:reembed <정제 인덱스> unused <새 후보>`를 실행한다. BM25는 `pnpm run rag:eval:corpus <정제 인덱스> data/evals/rag/revision-v1-qrels-v2.json docs/references/revision-v3/candidate.json`이다. 의미 검색은 `SANGFOR_RAG_EVAL_ASYNC=1`, 검증한 MiniLM provider/model/revision, 재정렬 비활성에서 새 후보를 평가한다. Dense alpha=1, Hybrid alpha=0.5, RRF alpha=0.5와 fusion=rrf를 사용했다. 추가 세트는 `data/evals/rag/revision-v3-validation.json`이다. 실제 설정은 각 보고서의 settings를 따른다.

서로 다른 설정/인덱스 실험은 기술적 비교이며 운영 승격 승인 또는 답변 정확도 평가가 아니다. 재정렬 보고서의 implementation SHA는 중간 실험 코드이며 최종 코드와 구분한다.
