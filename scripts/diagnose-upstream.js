#!/usr/bin/env node
'use strict';
// 默认离线;单渠道模式必须明确选择渠道、次数并确认运行,不接受 URL/Key。
const { run, options, LIMITS, DEFAULTS } = require('../lib/diagnostics/run');
const provider = require('../lib/diagnostics/provider');
function parse(args) {
  const input = {};
  const names = { '--concurrency': 'concurrency', '--requests': 'requests', '--duration-ms': 'durationMs', '--timeout-ms': 'timeoutMs', '--scenario': 'scenario', '--mode': 'mode', '--provider': 'provider', '--model': 'model' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--confirm-run') {
      if (input.confirm) throw new Error('参数重复;使用 --help');
      input.confirm = true;
      continue;
    }
    const key = names[args[i]], value = args[++i];
    if (!key || value === undefined || key in input) throw new Error('参数未知、重复或缺值;使用 --help');
    const numeric = ['concurrency', 'requests', 'durationMs', 'timeoutMs'].includes(key);
    if (numeric && !/^[1-9][0-9]*$/.test(value)) throw new Error('数值参数必须是正整数');
    input[key] = numeric ? Number(value) : value;
  }
  if (input.mode === 'provider') return provider.options(input);
  if (input.mode && input.mode !== 'offline') throw new Error('mode 只能是 offline 或 provider');
  delete input.mode;
  return options(input);
}
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('默认离线受控诊断:真实临时 mixrouter → 本地故障桩。\n' +
      '--scenario mixed|success|429|500|first-byte|idle|deadline|401\n' +
      '--concurrency N --requests N --duration-ms N --timeout-ms N\n' +
      `默认: ${JSON.stringify(DEFAULTS)}\n硬上限: ${JSON.stringify(LIMITS)}\n` +
      '离线总请求数为客户端请求,每条最多两次本地上游调用。时长约束发送窗口及在途请求;另有启动5秒、取证2秒、清理1.5秒上限。\n\n' +
      '可选渠道模式（会产生费用、可能触发限流;不等于运行授权）:\n' +
      'MIXR_DATA_DIR=/absolute/path node scripts/diagnose-upstream.js --mode provider --provider ID --requests N --confirm-run [--model NAME]\n' +
      `渠道默认: ${JSON.stringify(provider.DEFAULTS)};硬上限: ${JSON.stringify(provider.LIMITS)}\n` +
      '仅调用所选本地配置渠道,使用配置凭据及direct/出站transport;不接受URL或命令行Key、不跟随重定向、不重试、不扫描。\n' +
      '只发ping及低输出上限(messages/chat=1,responses=16),不记录响应体/Key。时长到点取消在途请求;另有进程启动5秒与清理0.5秒余量。');
    return;
  }
  const config = parse(args);
  const controller = new AbortController();
  const handlers = {};
  for (const [name, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    handlers[name] = () => { process.exitCode = code; controller.abort(); };
    process.once(name, handlers[name]);
  }
  try { console.log(JSON.stringify(await (config.mode === 'provider' ? provider.run : run)(config, { signal: controller.signal }), null, 2)); }
  finally { for (const [name, handler] of Object.entries(handlers)) process.removeListener(name, handler); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parse, main };
