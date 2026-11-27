// Desktop development only. A fixed loopback Ollama endpoint; no browser-supplied host or secret.
function localModels(data) {
  return (Array.isArray(data.models) ? data.models : []).filter(model => typeof model.name === 'string' && !model.name.toLowerCase().endsWith(':cloud') && !model.remote_host && !model.remote_model).map(model => model.name);
}
function createLocalModelMiddleware({
  fetchImpl = fetch
} = {}) {
  let busy = false;
  return async (request, response, next) => {
    if (!request.url?.startsWith('/__stella-model/')) return next();
    const send = (status, body) => {
      if (response.writableEnded) return;
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      response.end(JSON.stringify(body));
    };
    const host = request.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host) || request.headers['sec-fetch-site'] === 'cross-site' || request.headers.origin && request.headers.origin !== `http://${host}`) {
      send(403, {
        error: '허용되지 않은 요청입니다'
      });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    let acquired = false;
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const route = request.url.split('?')[0];
      if (!(request.method === 'GET' && route === '/__stella-model/models' || request.method === 'POST' && route === '/__stella-model/ask')) {
        send(404, {
          error: '지원하지 않는 경로입니다'
        });
        return;
      }
      const modelsResponse = await fetchImpl('http://127.0.0.1:11434/api/tags', {
        signal: controller.signal,
        redirect: 'error'
      });
      if (!modelsResponse.ok) throw new Error('unavailable');
      const models = localModels(await modelsResponse.json());
      if (request.method === 'GET') {
        send(200, {
          models
        });
        return;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) {
          send(413, {
            error: '입력이 너무 깁니다'
          });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(400, {
          error: '입력을 확인해 주세요'
        });
        return;
      }
      if (!body || !models.includes(body.model) || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000 || body.consent !== true) {
        send(400, {
          error: '로컬 모델을 선택했는지, 질문을 입력하고 전송에 동의했는지 확인해 주세요'
        });
        return;
      }
      if (busy) {
        send(429, {
          error: '이전 응답이 끝난 뒤 다시 요청해 주세요'
        });
        return;
      }
      busy = true;
      acquired = true;
      const result = await fetchImpl('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: body.model,
          stream: false,
          think: false,
          options: {
            num_ctx: 10000,
            num_predict: 1024,
            temperature: 0
          },
          messages: [{
            role: 'user',
            content: body.prompt
          }]
        })
      });
      if (!result.ok) throw new Error('unavailable');
      const payload = await result.json();
      if (typeof payload.message?.content !== 'string' || !payload.message.content.trim()) throw new Error('invalid');
      send(200, {
        text: payload.message.content,
        model: body.model
      });
    } catch {
      send(503, {
        error: '로컬 모델에 연결하지 못했습니다. 이 PC의 Ollama 실행 상태와 모델을 확인해 주세요.'
      });
    } finally {
      clearTimeout(timer);
      if (acquired) busy = false;
    }
  };
}
module.exports = {
  createLocalModelMiddleware,
  localModels
};
