import { spawn } from 'child_process';
import http from 'http';

const chromeProc = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--remote-debugging-port=9342',
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  'http://localhost:5173/'
]);

setTimeout(async () => {
  http.get('http://127.0.0.1:9342/json/list', res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', async () => {
      const target = JSON.parse(data).find(t => t.type === 'page');
      const ws = new WebSocket(target.webSocketDebuggerUrl);

      let id = 1;
      function send(method, params = {}) {
        return new Promise((resolve) => {
          const curId = id++;
          const handler = (evt) => {
            const msg = JSON.parse(evt.data);
            if (msg.id === curId) {
              ws.removeEventListener('message', handler);
              resolve(msg.result);
            }
          };
          ws.addEventListener('message', handler);
          ws.send(JSON.stringify({ id: curId, method, params }));
        });
      }

      ws.onopen = async () => {
        const check = await send('Runtime.evaluate', {
          expression: `(() => {
            const triggers = ScrollTrigger.getAll();
            return {
              triggerCount: triggers.length,
              triggerDetails: triggers.map(t => ({
                id: t.vars.id || t.trigger ? t.trigger.className : 'no-trigger',
                start: t.start,
                end: t.end,
                isActive: t.isActive
              }))
            };
          })()`,
          returnByValue: true
        });

        console.log('Registered ScrollTriggers:', JSON.stringify(check.result.value, null, 2));

        chromeProc.kill();
        process.exit(0);
      };
    });
  });
}, 1500);
