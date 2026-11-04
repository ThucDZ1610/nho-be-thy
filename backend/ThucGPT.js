const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5vl:3b';

const systemPrompt = [
  'Bạn là ThucGPT. Trả lời tiếng Việt, đúng trọng tâm, dễ hiểu, thường gói gọn trong 1-3 câu.',
  'Kiểm tra logic và dữ kiện trước khi đáp; không bịa, lặp đề hoặc trình bày suy nghĩ nội bộ.',
  'Nếu thiếu dữ kiện quan trọng, hỏi ngắn gọn. Chỉ hỗ trợ kiểm thử bảo mật có ủy quyền.'
].join(' ');

async function askThucGPT(messages, onToken = () => {}, signal = AbortSignal.timeout(180000)) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      keep_alive: '30m',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.images?.length ? { images: message.images } : {})
        }))
      ],
      options: { temperature: 0.45, num_ctx: 4096, num_predict: 160 }
    }),
    signal
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama trả lỗi ${response.status}: ${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line);
      if (chunk.error) throw new Error(chunk.error);
      const token = chunk.message?.content || '';
      if (token) {
        answer += token;
        onToken(token);
      }
    }

    if (done) break;
  }

  if (buffer.trim()) {
    const chunk = JSON.parse(buffer);
    if (chunk.error) throw new Error(chunk.error);
    const token = chunk.message?.content || '';
    if (token) {
      answer += token;
      onToken(token);
    }
  }

  answer = answer.trim();
  if (!answer) throw new Error('Ollama không trả về nội dung.');
  return answer;
}

async function checkOllama() {
  const response = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('Không kết nối được Ollama.');

  const result = await response.json();
  return {
    connected: true,
    model: OLLAMA_MODEL,
    modelReady: result.models?.some((model) => model.name === OLLAMA_MODEL || model.name.startsWith(`${OLLAMA_MODEL}:`)) ?? false
  };
}

module.exports = { askThucGPT, checkOllama, OLLAMA_MODEL };
