const SENSITIVE_LEARNING_TOPIC =
  /\b(?:passwords?|otps?|mfa|license keys?|secrets?|privacy polic(?:y|ies)|personal information)\b/i;

export function containsSensitiveLearningTopic(text: string): boolean {
  return SENSITIVE_LEARNING_TOPIC.test(text);
}
