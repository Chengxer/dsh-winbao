'use strict';

// DeepSeek 账户余额查询（主进程模块，供对话统计栏小部件 / chrome 菜单使用）。
//
// 密钥来源：环境变量 DEEPSEEK_API_KEY > DSH_HOME/.credentials.yaml。
// 端点：https://api.deepseek.com/user/balance；可用环境变量覆盖：
//   DEEPSEEK_BALANCE_URL —— 完整端点 URL（自定义代理/镜像）
//   DEEPSEEK_API_BASE    —— API 基址（自动拼接 /user/balance）

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE = 'https://api.deepseek.com';

// 各模型价格（¥/百万 token，官方定价档；deepseek-v4-pro 尚无公开定价，
// 暂按 reasoner 档估算，可在 settings.json 的 balancePrices 中覆盖）。
const DEFAULT_PRICES = {
  'deepseek-chat': { cacheMiss: 2, cacheHit: 0.5, output: 8 },
  'deepseek-reasoner': { cacheMiss: 4, cacheHit: 1, output: 16 },
  'deepseek-v4-pro': { cacheMiss: 4, cacheHit: 1, output: 16 },
};
const FALLBACK_PRICES = { cacheMiss: 2, cacheHit: 0.5, output: 8 };

function readApiKey(dshHome) {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey.trim();
  try {
    const text = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)/);
      if (m) return m[1];
    }
  } catch {}
  return '';
}

// 当前默认模型（~/.dsh/settings.yaml 的 agent-default-model.model），
// 决定按哪一档价格估算本轮费用。
function readActiveModel(dshHome) {
  try {
    const text = fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8');
    const m = text.match(/^\s*model\s*:\s*(\S+)/m);
    if (m) return m[1];
  } catch {}
  return '';
}

function balanceEndpoint() {
  if (process.env.DEEPSEEK_BALANCE_URL) return process.env.DEEPSEEK_BALANCE_URL;
  const base = (process.env.DEEPSEEK_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return base + '/user/balance';
}

function fetchJson(url, apiKey, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { Authorization: 'Bearer ' + apiKey, 'User-Agent': 'DSH-Desktop' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 1024 * 1024) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const hint = body.slice(0, 200).trim();
            return reject(new Error('HTTP ' + res.statusCode + (hint ? '：' + hint : '')));
          }
          try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON 解析失败')); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// 返回 { ok, isAvailable?, balances: [{currency,total,granted,toppedUp}], error?, prices }
async function queryBalance(dshHome) {
  const key = readApiKey(dshHome);
  if (!key) return { ok: false, error: 'no-key', balances: [], prices: DEFAULT_PRICES };
  try {
    const data = await fetchJson(balanceEndpoint(), key);
    const balances = Array.isArray(data.balance_infos)
      ? data.balance_infos.map((b) => ({
          currency: String(b.currency || ''),
          total: Number(b.total_balance) || 0,
          granted: Number(b.granted_balance) || 0,
          toppedUp: Number(b.topped_up_balance) || 0,
        }))
      : [];
    return { ok: true, isAvailable: !!data.is_available, balances, prices: DEFAULT_PRICES };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), balances: [], prices: DEFAULT_PRICES };
  }
}

module.exports = { queryBalance, readActiveModel, DEFAULT_PRICES, FALLBACK_PRICES };
