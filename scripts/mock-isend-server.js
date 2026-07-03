const http = require('http');

/**
 * Simple mock server for iSend login requests.
 * Useful for local testing when the real iSend API is unavailable.
 */
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (
    req.url.startsWith('/Json/Public/login') ||
    req.url.startsWith('/IsisWMS-War/Json/Public/login') ||
    req.url.endsWith('/api/login')
  )) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // echo a successful login response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, returnObject: { sessionId: 'mock-session', sessionPassword: 'mock-pass' } }));
    });
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/Json/InvEntity/doQueryStorageClientInventoryPage')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        returnObject: {
          totalSize: 0,
          currentOffset: 0,
          currentLength: 1000,
          currentPageData: [],
          totalRecord: 0,
        },
        msgList: { actualAdd: true, log: null, msgList: [] },
      }));
    });
    return;
  }
  // default
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Mock iSend server listening on port ${port}`));
