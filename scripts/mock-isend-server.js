const http = require('http');

/**
 * Simple mock server for iSend login requests.
 * Useful for local testing when the real iSend API is unavailable.
 */
function readBody(req, callback) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => callback(Buffer.concat(chunks).toString()));
}

function hasSession(req) {
  return Boolean(req.headers.sessionid && req.headers.sessionpassword)
    || /(?:^|;\s*)JSESSIONID=/.test(req.headers.cookie || '');
}

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (
    req.url.startsWith('/Json/Public/login') ||
    req.url.startsWith('/IsisWMS-War/Json/Public/login') ||
    req.url.endsWith('/api/login')
  )) {
    readBody(req, () => {
      sendJson(res, 200, {
        success: true,
        returnObject: { sessionId: 'mock-session', sessionPassword: 'mock-pass' },
      }, {
        'Set-Cookie': 'JSESSIONID=mock-jsession; Path=/; HttpOnly',
      });
    });
    return;
  }
  if (req.method === 'POST' && (
    req.url.startsWith('/Json/InvEntity/doQueryStorageClientInventoryPage') ||
    req.url.startsWith('/IsisWMS-War/Json/InvEntity/doQueryStorageClientInventoryPage')
  )) {
    readBody(req, () => {
      if (!hasSession(req)) {
        sendJson(res, 401, { success: false, msgList: { msgList: [{ msgCode: 'missing session' }] } });
        return;
      }

      sendJson(res, 200, {
        success: true,
        returnObject: {
          totalSize: 0,
          currentOffset: 0,
          currentLength: 1000,
          currentPageData: [],
          totalRecord: 0,
        },
        msgList: { actualAdd: true, log: null, msgList: [] },
      });
    });
    return;
  }
  if (req.method === 'POST' && (
    req.url.startsWith('/Json/WebApiOrder/doAddWebApiOrder') ||
    req.url.startsWith('/IsisWMS-War/Json/WebApiOrder/doAddWebApiOrder')
  )) {
    readBody(req, (text) => {
      if (!hasSession(req)) {
        sendJson(res, 401, { success: false, msgList: { msgList: [{ msgCode: 'missing session' }] } });
        return;
      }

      const body = text ? JSON.parse(text) : {};
      sendJson(res, 200, {
        success: Boolean(body.detailList && body.buyerCustAddr && body.deliverToCustAddr),
        returnObject: { orderId: body.orderId || 'mock-order' },
        msgList: { actualAdd: true, log: null, msgList: [] },
      });
    });
    return;
  }
  if (req.method === 'POST' && (
    req.url.startsWith('/Json/WhseOrder/doQueryOrderPage') ||
    req.url.startsWith('/IsisWMS-War/Json/WhseOrder/doQueryOrderPage')
  )) {
    readBody(req, () => {
      if (!hasSession(req)) {
        sendJson(res, 401, { success: false, msgList: { msgList: [{ msgCode: 'missing session' }] } });
        return;
      }

      sendJson(res, 200, {
        success: true,
        returnObject: { totalRecord: 0, currentPageData: [] },
        msgList: { actualAdd: true, log: null, msgList: [] },
      });
    });
    return;
  }
  // default
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Mock iSend server listening on port ${port}`));
