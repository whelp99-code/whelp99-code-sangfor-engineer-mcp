-- Promotion evidence is nonce authority and must remain physically append-only.
-- RLS limits scope; this trigger independently refuses rewrites within that scope.
CREATE OR REPLACE FUNCTION "blro_refuse_rag_index_promotion_evidence_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'BLRO_RAG_INDEX_PROMOTION_EVIDENCE_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS "BlroRagIndexPromotionEvidence_append_only"
  ON "BlroRagIndexPromotionEvidence";
CREATE TRIGGER "BlroRagIndexPromotionEvidence_append_only"
BEFORE UPDATE OR DELETE ON "BlroRagIndexPromotionEvidence"
FOR EACH ROW
EXECUTE FUNCTION "blro_refuse_rag_index_promotion_evidence_rewrite"();
