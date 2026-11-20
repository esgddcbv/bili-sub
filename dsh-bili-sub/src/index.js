/**
 * dsh-bili-sub —— 把 bili-sub 的 CLI 包成一个宿主工具 `bili_sub`。
 *
 * 这个插件只做一件事：让 Agent 在会话里能「先验真再信字幕」。
 * 真正的抓取与判定逻辑全在 `src/vendor/bili-sub.mjs`（与 GitHub 上的 CLI 同一份），
 * 这里只负责拼参数、跑子进程、把结果交回去。
 */

import { spawn } from 'node:child_process';
import { defineToolCompat } from './define-tool.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'vendor', 'bili-sub.mjs');

/**
 * 把 author spec（属性名 → 值 schema，`required: true` 写在属性里）
 * 编译成宿主 `register()` 认的 JSON Schema。
 *
 * 规则照抄 `@deepseek-ai/dsh-tools` 的 runSchemaCompiler：
 *   - 属性上的 `required: true` 提升到父级 `required` 数组，并从属性里删掉；
 *   - `type: 'json'` 是 author-only 节点，退化成 `{}`；
 *   - `properties` / `items` 递归，其余键原样透传。
 */
function compile(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const out = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k === 'required') continue;
    out[k] = v;
  }
  if (spec.type === 'json') {
    out.type = undefined;
    delete out.type;
  }
  if (spec.properties) {
    const props = {};
    const required = Array.isArray(spec.required) ? [...spec.required] : [];
    for (const [name, sub] of Object.entries(spec.properties)) {
      const next = { ...sub };
      const isRequired = next.required === true;
      delete next.required;
      props[name] = compile(next);
      if (isRequired && !required.includes(name)) required.push(name);
    }
    out.properties = props;
    if (required.length) out.required = required;
  }
  if (spec.items) out.items = compile(spec.items);
  return out;
}

function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out, err: `${err}\n（超时 ${Math.round(timeoutMs / 1000)} 秒，已终止）` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -2, out, err: String(e && e.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const TOOL = {
  name: 'bili_sub',
  description: [
    '取 B 站视频的 AI 字幕，并在用它之前先验真。',
    'B 站的 `/x/player/v2` 会漂：同一个 BV 早晚可能返回别的视频的字幕，也可能返回空。',
    '所以这个工具的返回值里自带判定（命中率、语速、字数），`FAIL` 的那条不要拿去当教材。',
    'action=probe 只看有没有字幕、cid 和时长；action=fetch 拉一条并判真伪；action=verify 整目录复核。',
  ].join(' '),
  parameters: {
    cmd: { type: 'string', description: '要执行的子命令，例如 probe BV1z8hBzNEB7 / fetch BV1z8hBzNEB7 / verify --dir D:\\知识库\\99_原始字幕 --online' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string' },
        meta: { type: 'object' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value.text }];
    },
  },
  timeoutMs: 180_000,
  async execute(args = {}) {
    const raw = String(args.cmd || args.command || '').trim();
    if (!raw) return { text: '要给 cmd，例如 probe BV1z8hBzNEB7' };
    const argv = raw.split(/\s+/).filter(Boolean);
    const sub = argv[0].toLowerCase();
    if (!['probe', 'fetch', 'plan', 'verify', 'batch'].includes(sub)) {
      return { text: `未知子命令 ${sub}（可用 probe / fetch / plan / verify）` };
    }
    const r = await runCli(argv, 180_000);
    const body = [r.out.trim(), r.err.trim()].filter(Boolean).join('\n');
    const head = r.code === 0 ? '' : `退出码 ${r.code}\n`;
    return { text: (head + (body || '（没有输出）')).slice(0, 8000), meta: { cmd: raw, code: r.code } };
  },
};

export const name = 'dsh-bili-sub';
export const inject = ['tools'];

export function apply(ctx) {
  // 必须走 defineTool：register() 收编译好的 JSON Schema；直接把 author spec
  // 塞进去，宿主会原样发给模型 → INVALID_REQUEST（properties.title 不是 "string"）。
  const tool = { ...TOOL };
  ctx.tools.register(tool);
  // 注册成功留一行日志：出问题时「加载失败」和「装了两份被去重」看起来都很安静
  ctx.logger?.info?.('dsh-bili-sub: 已注册工具 bili_sub');
}
