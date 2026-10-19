'use strict';
const os = require('node:os');
const path = require('node:path');
const { localOptions } = require('../lib/cli/local-options');
const { diagnose, formatReport } = require('../lib/cli/doctor');

const HELP = `用法: npm run doctor -- [--data-dir <绝对路径>] [--port <端口>] [--ui-port <端口>] [--offline] [--json]

只读检查 Node、运行文件、数据目录、配置 JSON 与本机服务。
默认数据目录与 npm run local 一致: ~/.local/share/mixrouter/data。
旧版 npm start 的数据目录请用 --data-dir 明确指定。
--offline 不连接任何端口;--json 输出结构化结果。
不发上游请求、不改配置、不打印 Key、渠道 URL 或会话内容。
退出码:0=无阻断问题(可能有警告),1=发现错误,2=用法错误。`;

async function main(args = process.argv.slice(2)) {
  try {
    const options = localOptions(args, { root: path.resolve(__dirname, '..'), home: os.homedir(), doctor: true });
    if (options.help) { console.log(HELP); return 0; }
    const report = await diagnose(options);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.ok ? 0 : 1;
  } catch (e) {
    const result = { ok: false, error: e.message };
    console.error(args.includes('--json') ? JSON.stringify(result) : `${e.message}\n${HELP}`);
    return 2;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main, HELP };
