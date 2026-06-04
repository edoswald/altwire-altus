export function buildTopicSynthesisPrompt({ topic, findings }) {
  const bulletList = Array.isArray(findings) && findings.length > 0
    ? findings.map((item) => `- ${item}`).join('\n')
    : '- No findings provided';

  return `You are Altus for AltWire, an editorial AI assistant.\nCreate an editorial synthesis for topic: ${topic}\n${bulletList}`;
}

export async function synthesizeTopic({ topic, findings }) {
  return {
    success: true,
    topic,
    prompt: buildTopicSynthesisPrompt({ topic, findings }),
  };
}
