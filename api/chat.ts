type TarotCardInput = {
  name?: string;
  tags?: string[];
  description?: string;
};

type ChatBody = {
  pastCard?: TarotCardInput;
  presentCard?: TarotCardInput;
  futureCard?: TarotCardInput;
};

const encoder = new TextEncoder();

function sse(data: string) {
  return encoder.encode(`data: ${data}\n\n`);
}

function safeTags(tags?: string[]) {
  return Array.isArray(tags) ? tags.filter(Boolean).slice(0, 3).join(' / ') : '';
}

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const apiKey = process.env.LLM_API_KEY;
    if (!apiKey) {
      return new Response('Missing LLM_API_KEY', { status: 500 });
    }

    const body = (await req.json()) as ChatBody;
    const past = body.pastCard;
    const present = body.presentCard;
    const future = body.futureCard;
    if (!past?.name || !present?.name || !future?.name) {
      return new Response('Invalid cards payload', { status: 400 });
    }

    const systemPrompt = [
      '你是一位资深塔罗占卜师，表达风格坚定、平和、专业，带一点洞察人心的穿透力。',
      '严禁使用空洞抒情词，例如：指尖轻抚、优雅的因果、灵魂的回响，以及同类舞台剧式词汇。',
      '输出必须清晰、具体、可执行，不要写成诗，不要玄乎其玄。',
      '结语字数严格 150-200 字。',
      '必须严格包含且正确引用三张牌名：过去牌、现在牌、未来牌（与输入完全一致）。',
      '输出采用三层结构，且每层各 1-2 句：',
      '1) 现状洞察 2) 因果串联 3) 行动建议。',
    ].join(' ');

    const userPrompt = [
      '请按以下信息生成“命运结语”：',
      `过去：${past.name} (Tags: ${safeTags(past.tags)}, Desc: ${past.description ?? ''})`,
      `现在：${present.name} (Tags: ${safeTags(present.tags)}, Desc: ${present.description ?? ''})`,
      `未来：${future.name} (Tags: ${safeTags(future.tags)}, Desc: ${future.description ?? ''})`,
      '',
      '硬性规则：',
      '- 不要复读 Desc 原句，要重组为因果链。',
      '- 必须体现“因为过去...导致现在...所以未来需要...”的逻辑。',
      '- 用简单易懂的语句，不要高深抽象。',
      '- 输出格式如下（保留标题）：',
      '【现状洞察】...',
      '【因果串联】...',
      '【行动建议】...',
      '- 总字数 150-200 字。',
    ].join('\n');

    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.85,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const msg = await upstream.text();
      return new Response(msg || 'LLM upstream error', { status: upstream.status || 502 });
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const payload = t.slice(5).trim();
              if (payload === '[DONE]') {
                controller.enqueue(sse('[DONE]'));
                continue;
              }
              try {
                const json = JSON.parse(payload);
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length > 0) {
                  controller.enqueue(sse(delta));
                }
              } catch {
                // ignore malformed chunk
              }
            }
          }
          controller.enqueue(sse('[DONE]'));
          controller.close();
        } catch (e) {
          controller.error(e);
        } finally {
          reader.releaseLock();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch {
    return new Response('Internal error', { status: 500 });
  }
}
