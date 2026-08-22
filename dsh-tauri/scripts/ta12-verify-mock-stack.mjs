#!/usr/bin/env node
// ta12-verify-mock-stack.mjs —— ta12-verify-update-sources.test.mjs 的 mock 服务进程。
//
// 为什么独立进程：测试宿主进程内起的 server 在当前执行沙箱下收不到「子进程 →
// 宿主 server」的回程数据（连接建立但响应丢失）；而「兄弟子进程 ↔ 兄弟子进程」
// 的回环流量正常。故 mock 栈（CONNECT 代理 + TLS MITM 应用层）跑在本独立进程，
// 由测试宿主拉起，被测脚本（同为宿主的子进程）经 HTTPS_PROXY 连进来。
//
// 协议：
//   node ta12-verify-mock-stack.mjs <stateFile.json>
// 启动后向 stdout 写一行 JSON：{"port":<proxyPort>,"ca":"<ca.pem 路径>"}。
// 每个请求都会重读 stateFile（测试用例按需改写，实现逐用例 mock）。
//
// stateFile 形态：
//   {
//     "ghLatestCode": 200, "geeLatestCode": 200,
//     "gh": {...releases/latest JSON...}, "gee": {...},
//     "assets": { "<url>": { "contentLength"?: n, "body"?: s, "code"?: n } }
//   }

import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const stateFile = process.argv[2];
if (!stateFile) { console.error('用法: node ta12-verify-mock-stack.mjs <stateFile.json>'); process.exit(2); }

const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

// ---- 一次性 CA + 多 SAN 服务器证书（openssl，临时目录，不触碰系统信任库）----
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-vus-certs-'));
const extFile = path.join(certDir, 'ext.cnf');
fs.writeFileSync(extFile, [
  'subjectAltName=DNS:api.github.com,DNS:github.com,DNS:objects.githubusercontent.com,DNS:gitee.com,DNS:assets.gitee.com,DNS:localhost,IP:127.0.0.1',
  'basicConstraints=CA:FALSE',
  'keyUsage=digitalSignature,keyEncipherment',
  'extendedKeyUsage=serverAuth',
].join('\n'));
const o = (args) => execFileSync('openssl', args, { cwd: certDir, stdio: ['ignore', 'ignore', 'pipe'] });
o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=TA12 Test CA']);
o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=api.github.com']);
o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '1', '-extfile', extFile]);

// ---- 应用层路由（每请求重读 state）----
const handler = (req, res) => {
  let st;
  try { st = readState(); } catch { res.writeHead(500); res.end('state unreadable'); return; }
  const host = (req.headers.host || '').split(':')[0];
  if (host === 'api.github.com' && /\/releases\/latest$/.test(req.url)) {
    if ((st.ghLatestCode ?? 200) !== 200) { res.writeHead(st.ghLatestCode); res.end('boom'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(st.gh));
    return;
  }
  if (host === 'gitee.com' && /\/releases\/latest$/.test(req.url)) {
    if ((st.geeLatestCode ?? 200) !== 200) { res.writeHead(st.geeLatestCode); res.end('boom'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(st.gee));
    return;
  }
  const url = `https://${host}${req.url}`;
  const a = (st.assets || {})[url];
  if (!a) { res.writeHead(404); res.end('no such asset'); return; }
  if (a.code) { res.writeHead(a.code); res.end(); return; }
  const headers = {};
  if (a.contentLength != null) headers['content-length'] = String(a.contentLength);
  if (a.body != null) {
    headers['content-type'] = 'text/plain';
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); }
    else { res.writeHead(200, headers); res.end(a.body); }
    return;
  }
  res.writeHead(200, headers); res.end('');
};

// ---- TLS 层 + CONNECT 代理 ----
const tlsApp = https.createServer({
  key: fs.readFileSync(path.join(certDir, 'srv.key')),
  cert: fs.readFileSync(path.join(certDir, 'srv.pem')),
}, handler);
await new Promise((r) => tlsApp.listen(0, '127.0.0.1', r));

const proxy = http.createServer();
proxy.on('connect', (req, clientSocket, head) => {
  const upstream = net.connect(tlsApp.address().port, '127.0.0.1', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

process.stdout.write(JSON.stringify({ port: proxy.address().port, ca: path.join(certDir, 'ca.pem') }) + '\n');

// 空转保活；由测试宿主 kill。
setInterval(() => {}, 60_000);
