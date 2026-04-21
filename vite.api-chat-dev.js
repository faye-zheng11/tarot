/**
 * 仅用于本地 `vite dev`：转发 POST /api/chat，读取根目录 .env 的 LLM_API_KEY。
 * 生产环境仍由 Vercel `api/chat.ts` 处理。
 */

function safeTags(tags) {
  return Array.isArray(tags) ? tags.filter(Boolean).slice(0, 3).join(' / ') : '';
}

function buildPrompts(body) {
  const past = body.pastCard;
  const present = body.presentCard;
  const future = body.futureCard;
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

  return { systemPrompt, userPrompt };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function apiChatDevPlugin(env) {
  return {
    name: 'api-chat-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/chat') || req.method !== 'POST') {
          next();
          return;
        }

        const apiKey = env.LLM_API_KEY || process.env.LLM_API_KEY;
        if (!apiKey) {
          res.statusCode = 500;
          res.end('Missing LLM_API_KEY');
          return;
        }

        let jsonBody;
        try {
          const raw = await readBody(req);
          jsonBody = JSON.parse(raw || '{}');
        } catch {
          res.statusCode = 400;
          res.end('Invalid JSON');
          return;
        }

        const past = jsonBody.pastCard;
        const present = jsonBody.presentCard;
        const future = jsonBody.futureCard;
        if (!past?.name || !present?.name || !future?.name) {
          res.statusCode = 400;
          res.end('Invalid cards payload');
          return;
        }

        const { systemPrompt, userPrompt } = buildPrompts(jsonBody);

        let upstream;
        try {
          upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
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
        } catch {
          res.statusCode = 502;
          res.end('Upstream fetch failed');
          return;
        }

        if (!upstream.ok) {
          const msg = await upstream.text();
          res.statusCode = upstream.status || 502;
          res.end(msg || 'LLM upstream error');
          return;
        }
        if (!upstream.body) {
          res.statusCode = 502;
          res.end('No stream body');
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');

        const decoder = new TextDecoder();
        let buf = '';

        const flushLine = (line) => {
          const t = line.trim();
          if (!t.startsWith('data:')) return;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') {
            res.write(`data: [DONE]\n\n`);
            return;
          }
          try {
            const j = JSON.parse(payload);
            const delta = j?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              res.write(`data: ${delta}\n\n`);
            }
          } catch {
            /* ignore */
          }
        };

        try {
          const reader = upstream.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) flushLine(line);
          }
          if (buf.trim()) flushLine(buf);
          res.write(`data: [DONE]\n\n`);
          res.end();
        } catch {
          if (!res.writableEnded) res.end();
        }
      });
    },
  };
}
