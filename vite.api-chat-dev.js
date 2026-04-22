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
  const userQuestion = String(body.userQuestion ?? '').trim() || '未提供';
  const intent = body.intent === 'starGuide' ? 'starGuide' : 'fate';

  if (intent === 'starGuide') {
    const selectedCards = [
      `过去「${past.name}」：${String(past.description ?? '').trim() || '（无牌面释义）'}`,
      `现在「${present.name}」：${String(present.description ?? '').trim() || '（无牌面释义）'}`,
      `未来「${future.name}」：${String(future.description ?? '').trim() || '（无牌面释义）'}`,
    ].join('\n');

    const systemPrompt = [
      '你是一位懂塔罗、也懂追星语境的运势撰稿人。',
      '语气温柔、亲切，像追星好友私聊互助，不说教、不端着。',
      '禁止使用「优雅、因果、灵魂」等词；不要写成散文诗。',
      '核心：必须结合「牌面含义」解读「追星行为」（抢票、应援、心态、线下见面磁场等）。',
      '若牌意偏积极，可偏向欧气、现场高光；若偏内省或等待类牌，可偏向佛系追星、心态建设、静候回归。',
      '「星运解读」正文绝对不能包含“幸运色”或“幸运物”信息。 严禁出现任何艺人姓名、昵称、组合名（中英文都不允许）。',
    ].join(' ');

    const userPrompt = [
      '输入变量：',
      `userQuestion：${userQuestion}`,
      'selectedCards（三张牌名及含义）：',
      selectedCards,
      '',
      '请输出「星运指南」正文，并单独给出幸运色与幸运物。正文禁止出现任何艺人名字。',
      '严格按以下格式输出（保留标题行）：',
      '【星运解读】',
      '（此处 120–180 字，必须引用牌意并与追星场景结合）',
      '',
      '幸运色：（一个词或短语）',
      '幸运物：（一个与追星相关的物件或活动）',
      '',
      '硬性规则：',
      '- 总字数约 180–240 字（含幸运色、幸运物两行）。',
      '- 幸运色、幸运物只能出现在最后两行，严禁在【星运解读】正文重复出现。',
      '- 不要输出与上述无关的板块标题。',
    ].join('\n');

    return { systemPrompt, userPrompt };
  }

  const systemPrompt = [
   '你是一位洞察力极强的资深塔罗占卜师。',
   '核心任务：必须深度结合「用户提问」，将三张牌的能量转化为具体的现实生活图景。',
   '严禁直接生硬地套用牌面释义，要将牌面的含义“揉碎”进对用户困惑的分析中。',
   '语气平和、专业，充满悲悯心与客观性。',
   '只输出「命运结语」板块，确保每一句话都是在针对性地回答用户的问题。'
  ].join(' ');

  const userPrompt = [
    '请按以下信息生成「命运结语」：',
    `用户提问：${userQuestion}`,
    `过去：${past.name}（Tags: ${safeTags(past.tags)}；含义：${past.description ?? ''}）`,
    `现在：${present.name}（Tags: ${safeTags(present.tags)}；含义：${present.description ?? ''}）`,
    `未来：${future.name}（Tags: ${safeTags(future.tags)}；含义：${future.description ?? ''}）`,
    '',
    '只输出以下三行标题及正文（不要输出其它标题）：',
    '【现状洞察】：结合用户提问的具体情境，利用“现在”牌面揭示用户当下最真实、最隐秘的心态或困境根源。',
    '【因果串联】：连接“过去”到“未来”，描述这种能量是如何流动的。避免说“从某某牌到某某牌”，要说“从那种初期的某种状态演变为当下的某种局势”。',
    '【行动建议】：针对用户的问题，给出 1-2 条具有画面感、可立即执行的建议。',
    '',
    '硬性规则：',
    '- 总字数 180–240 字。',
    '- 体现「过去 → 现在 → 未来」的逻辑链。',
    '- 严禁跳脱出用户的问题范围。',
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
