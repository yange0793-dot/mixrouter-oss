'use strict';
// 上游模型证据:只记**上游原始 JSON/SSE 里自报的 model**,不回落请求模型,也不认转换器
// 合成出来的模型名。
//
// 为什么单独一个模块:同一个字段要在五条线上取——原生 Anthropic、原生 Responses、原生
// Chat、两条翻译线(Claude→chat/responses)与 Codex 的 Responses→Chat 桥。写法稍一分散,
// 就会出现"这条线记的是请求名、那条线记的是转换后的名字":两条记录都长得像真的,事后
// 无法分辨。这里只放**一个判据**:值必须来自协议里明确的 model 字段。
//
// 边界(与响应转发强相关):
//   · 只读、不改输入;不保存正文、prompt、工具名或任何自由文本,返回值只是一个经过
//     清洗的模型名字符串(或空串表示"未知")。
//   · 不缓冲整条流:SSE 取样由调用方给一段**已有**的有界样本(headTailUsage 的首尾窗、
//     relay 已解析的事件),本模块只在样本上做 O(n) 行扫描,不做逐块拼接。
//   · 解析失败、压缩体、字段缺失一律返回空串 —— 未知就是未知,绝不拿请求模型兜底。
//
// 采样文本的形态:headTailUsage 给出的是"首窗 + NUL + 尾窗",中间可能被裁掉,首尾也可能
// 停在半行。这里逐行只认 `data:` 开头的完整行;半行 JSON 解析失败即跳过,不会因为裁切
// 拼出一个假值。

// 与 request-log 对 upstream_model 的白名单校验保持同一口径:超过 512 字符或含控制字符
// 的值不进日志。这里先判掉,免得 entry 里出现一个必然会被落盘层丢弃的字符串。
const MODEL_MAX_CHARS = 512;
// 单行上限:SSE 的 data 行正常都在 KB 级;超长行(整包回答塞进一帧)不解析,按未知处理。
const LINE_MAX_CHARS = 64 * 1024;
// 一次最多扫描的字符数。headTailUsage 的默认样本 = 首 128KiB + 尾 128KiB + 1 个间隔符,
// 这里留出余量让它整段扫一次就够;更长的错误正文只扫首尾各一段,保持有界。
const SCAN_MAX_CHARS = 300 * 1024;

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// 只接受协议里的模型名字符串。trim 是必要的(个别网关会带尾随空白),除此之外不裁剪、
// 不改写、不做别名归一 —— 这个字段是"上游说了什么",不是"我们想让它是什么"。
function upstreamModelOf(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > MODEL_MAX_CHARS) return '';
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return '';
  return text;
}

// 从**原始上游对象**里认 model。只认三个协议位置,不递归、不遍历正文:
//   · 对象自身的 model —— Chat 整包/流块、Anthropic message、Responses response;
//   · Anthropic SSE message_start.message.model;
//   · Responses SSE response.*.response.model。
// 内容字段(choices[].delta.content 等)里的同名字样不在这些路径上,不会被误读。
function upstreamModelFromJson(value) {
  if (!isPlainObject(value)) return '';
  const direct = upstreamModelOf(value.model);
  if (direct) return direct;
  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'message_start' && isPlainObject(value.message)) {
    return upstreamModelOf(value.message.model);
  }
  if (type.startsWith('response.') && isPlainObject(value.response)) {
    return upstreamModelOf(value.response.model);
  }
  return '';
}

// 扫描一段 SSE 文本(完整流或 headTailUsage 的首尾样本)。只认 data: 行里能完整解析成
// JSON 的事件;`[DONE]`、注释行、event: 行、半截行一律跳过。首尾样本用 NUL 当间隔符
// (见 upstream-collect.headTailUsage),它不可能出现在协议 JSON 里,这里当作换行处理。
function scanSse(text) {
  for (const line of text.split(/\r\n|\n|\r|\u0000/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]' || payload.length > LINE_MAX_CHARS) continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    const model = upstreamModelFromJson(event);
    if (model) return model;
  }
  return '';
}

// 有界 SSE 取样:先扫首段,没找到再扫尾段。首段覆盖 Anthropic message_start、
// Responses response.created、Chat 首个 chunk —— 正常上游都在这里报模型;
// 尾段兜住"只在终态事件里报"的网关。中间被裁掉的部分不猜测。
function upstreamModelFromSse(text) {
  if (typeof text !== 'string' || !text) return '';
  const head = text.length > SCAN_MAX_CHARS ? text.slice(0, SCAN_MAX_CHARS) : text;
  const found = scanSse(head);
  if (found) return found;
  return head.length === text.length ? '' : scanSse(text.slice(-SCAN_MAX_CHARS));
}

// 整段上游正文(错误体是这条路):先看是不是一个完整的 JSON 对象,不是再按 SSE 扫。
// 解析失败/超长一律未知,不用正则去正文里"捞" model —— 回答里提到 {"model":...}
// 会因此变成假的证据。
function upstreamModelFromText(text) {
  if (typeof text !== 'string' || !text) return '';
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.length <= SCAN_MAX_CHARS) {
    try { return upstreamModelFromJson(JSON.parse(trimmed)); } catch { return ''; }
  }
  return upstreamModelFromSse(text);
}

// 第一次观测生效。同一次尝试内上游重复报同一个模型(chat 的每个 chunk 都会带)不再覆盖;
// 跨尝试的清零由调用方在 attempt 起点负责(见 lib/proxy/attempt.js),失败尝试的值
// 因此不会留到下一次成功。
function rememberUpstreamModel(entry, value) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
  if (entry.upstream_model) return entry.upstream_model;
  const model = upstreamModelOf(value);
  if (model) entry.upstream_model = model;
  return model;
}

function rememberUpstreamModelFromJson(entry, value) {
  return rememberUpstreamModel(entry, upstreamModelFromJson(value));
}

function rememberUpstreamModelFromSse(entry, text) {
  return rememberUpstreamModel(entry, upstreamModelFromSse(text));
}

function rememberUpstreamModelFromText(entry, text) {
  return rememberUpstreamModel(entry, upstreamModelFromText(text));
}

// 一次尝试开始时的清零。单独导出而不是让调用方各写一句赋值:字段的生命周期规则
// (只属于当前这一发)只应有一处定义。
function clearUpstreamModel(entry) {
  if (entry && typeof entry === 'object') entry.upstream_model = '';
}

module.exports = {
  MODEL_MAX_CHARS,
  upstreamModelOf,
  upstreamModelFromJson,
  upstreamModelFromSse,
  upstreamModelFromText,
  rememberUpstreamModel,
  rememberUpstreamModelFromJson,
  rememberUpstreamModelFromSse,
  rememberUpstreamModelFromText,
  clearUpstreamModel,
};
