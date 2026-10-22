'use strict';
// 失败解释:把一次失败的 (status, err_class, code) 翻成**能行动**的四句话。
//
// 这不是错误日志的替代品。日志回答"哪一发失败了、上游回了什么",这里只回答用户真正会问的:
//   · 这算什么类问题(分类);
//   · 影响是什么 —— 是账号废了、模型没了、还是这一发运气不好;
//   · 下一步去控制台哪里、做什么;
//   · 有没有可能是另一种原因(uncertain)。
//
// 三条硬约束:
//   1. **不笼统**:403 只归成"权限或风控",绝不写成"账号坏了";401 与 402 是两回事
//      (凭据错 vs 额度尽),429 与 5xx 也是两回事(歇一下 vs 上游自己坏)。
//   2. **不转述输入**:输出里的每个字都来自本文件的常量,status 只是校验过的整数。
//      上游错误正文可能带着 Key 或 HTML,一律不往这里带 —— 这既是防泄露,也是防 XSS。
//   3. **target 只指内部控制台页面**:返回的是 `#providers` 这类 hash,前端只当内部链接用;
//      没有可去的页面时为 '',不给外部 URL。
//
// 输入容错:status 不是 100..599 的整数按 0,err_class/code 只做小写与截断;认不出来就归
// unknown 并标 uncertain —— 宁可说"不确定,去诊断页看",也不编一个像模像样的原因。

const TARGETS = Object.freeze({
  overview: '#overview',
  providers: '#providers',
  routes: '#routes',
  sessions: '#sessions',
  usage: '#usage',
  diagnostics: '#diagnostics',
  settings: '#settings',
});
const TARGET_SET = new Set(Object.values(TARGETS));

const CATEGORIES = Object.freeze([
  'auth', 'model', 'rate', 'quota', 'network', 'timeout',
  'upstream', 'request', 'config', 'attempts', 'cancelled', 'unknown',
]);

const INPUT_MAX = 48;
const normalize = value => {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().toLowerCase().slice(0, INPUT_MAX);
};
const normalizeStatus = value => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 0;
};

// 六键固定:调用方与测试都按这个形状读,多一个键就是契约变更。
const guide = (category, title, impact, action, target, uncertain) => ({
  category,
  title,
  impact,
  action,
  target: TARGET_SET.has(target) ? target : '',
  uncertain: !!uncertain,
});

// ---------------------------------------------------------------- 路由/凭据类错误码
// 这些是代理**自己**产生的 error.type(见 lib/proxy/prepare.js 与 attempt.js),
// 请求根本没发出去,不能归到"上游故障"里 —— 那会把配置问题说成服务坏了。
const CODE_GUIDES = {
  no_route_error: () => guide('config', '没有可用的路由落点',
    '请求没有发往任何上游:客户端要的模型没有匹配到规则,或命中的规则指向已删除的渠道(僵尸引用)。',
    '到「路由」页为这个模型补一条规则、或修正指向已删渠道的规则;也可以先用 ./mixctl explain 看命中的是哪条规则。',
    TARGETS.routes, false),
  provider_disabled_error: () => guide('config', '命中的渠道被停用',
    '规则指向的渠道 enabled=false,请求在本地就被拦下,没有发往上游。',
    '到「渠道与 Key」页重新启用该渠道,或到「路由」页把它换成一个可用渠道。',
    TARGETS.providers, false),
  provider_key_unavailable_error: () => guide('config', '这条路由点名的 Key 不可用',
    '固定 Key / 压缩规则点名的账号被删、停用、重复或为空,请求没有发出去。与上游余额、模型都无关。',
    '到「渠道与 Key」页检查该渠道的账号下拉;压缩专用 Key 在「路由」页的压缩规则里重新选择。',
    TARGETS.providers, false),
  wire_api_mismatch_error: () => guide('config', '协议线与渠道不匹配',
    '客户端用的是 Claude 协议,但规则命中的候选渠道只支持 Responses / Chat 线(或反过来),请求没有发出去。',
    '到「渠道与 Key」页把该渠道的协议线改成与客户端一致,或到「路由」页把规则指向正确协议的渠道。',
    TARGETS.providers, false),
  bad_credential: () => guide('config', '渠道凭据里含换行或控制字符',
    'Key 里带换行或控制字符时请求无法构造,一个字节都没发出去;这不是"Key 被上游拒绝"。',
    '到「渠道与 Key」页重新粘贴该渠道的 API Key,确认末尾没有多余换行。',
    TARGETS.providers, false),
  unsupported_compaction: () => guide('config', '压缩落到了 Chat 渠道',
    '原生 Responses 压缩只能落到 responses 协议渠道;这条压缩规则的目标渠道没有 /v1/responses/compact。',
    '到「路由」页把压缩规则的渠道改成 Responses 渠道,或让池里至少有一个 Responses 渠道。',
    TARGETS.routes, false),
  too_many_attempts: () => guide('attempts', '本次请求的上游调用次数已用尽',
    '候选渠道与换 Key 重试都没有成功,请求按失败收尾;这不是某一家渠道的结论。',
    '到「诊断」页用 request_id 看这几次尝试各自的渠道与错误分类,再决定换渠道还是稍后再试。',
    TARGETS.diagnostics, false),
};

// err_class → 解释(err_class 由 mixrouter.js 的 errorClass 与转换线产生)
const CLASS_GUIDES = {
  rate_limit: () => guide('rate', '被上游限流(429)',
    '这一发没有产出内容,但账号与渠道本身可用;短时间连续 429 通常是并发或多人共用同一账号。',
    '等几秒重试(默认每次重试前已等 1 秒);持续 429 就换池内另一家渠道或降低并发。',
    TARGETS.providers, false),
  budget_exhausted: () => guide('quota', '渠道额度用尽(402)',
    '这家渠道的预算池在这个计费窗口里没有可用额度,与 Key 是否正确、模型是否存在无关。',
    '让池里另一家渠道承接这次请求,或到该渠道服务商处充值 / 等窗口刷新。',
    TARGETS.providers, false),
  upstream_server: () => guide('upstream', '上游服务故障(5xx)',
    '上游自己报错,问题不在本机与请求内容;同池换一家通常就能恢复。',
    '重试或切到池内其它渠道;到「诊断」页确认是单渠道故障还是全线故障。',
    TARGETS.diagnostics, false),
  upstream_request: () => guide('request', '上游拒绝了请求内容(4xx)',
    '渠道连通、凭据有效,但这次请求的字段或形状不被接受;不同渠道对同一请求的接受度不同。',
    '到「诊断」页对照状态码与模型名;换一家渠道再发同样的请求,可以区分"请求问题"与"渠道挑剔"。',
    TARGETS.diagnostics, true),
  timeout: () => guide('timeout', '等待上游超时',
    '到了首字节 / 空闲 / 端到端预算的上限,上游仍没有给出完整响应;上游可能仍在计费。',
    '到「诊断」页看这次用了多久、卡在哪个阶段;持续超时就换渠道或缩短上下文。',
    TARGETS.diagnostics, false),
  network_error: () => guide('network', '上游连接中断',
    '请求没有拿到完整响应:连接被重置 / 链路中断;客户端看到的往往是截断的流。',
    '重试一次;同一渠道反复中断就换渠道,并到「诊断」页确认是否稳定复现。',
    TARGETS.diagnostics, false),
  stream_aborted: () => guide('network', '上游流被中断',
    '响应头已经到了,但响应体在传输中途被上游或链路切断;客户端拿到的是截断内容。',
    '重试或换渠道;到「诊断」页看这次是不是稳定在同一渠道断流。',
    TARGETS.diagnostics, false),
  cancelled: () => guide('cancelled', '客户端已取消',
    '连接由客户端主动断开(ESC / 退出 / 本地超时),代理按取消收尾,不算渠道失败,也不计入渠道健康。',
    '重新发起即可;如果总是客户端先超时,检查客户端自己的超时设置。',
    '', false),
  // 网络错误码(errorClass 会把它们小写成类名)
  econnreset: () => guide('network', '连接被重置(ECONNRESET)',
    '上游或中间链路把连接切断了,这一发没有可用响应。',
    '重试一次;同一渠道反复重置就换渠道,并检查本机代理 / 链路。',
    TARGETS.diagnostics, false),
  econnrefused: () => guide('network', '连接被拒绝(ECONNREFUSED)',
    '目标端口没有在监听:渠道 Base URL 的域名/端口写错了,或本机到它的链路不通。',
    '到「渠道与 Key」页核对 Base URL 与端口,确认服务端可达。',
    TARGETS.providers, false),
  enotfound: () => guide('network', '域名解析失败(ENOTFOUND)',
    '渠道 Base URL 的主机名解析不出来:域名拼错、DNS 不可用,或该域名在当前网络被拦。',
    '到「渠道与 Key」页核对 Base URL;确认本机 DNS / 代理能解析这个域名。',
    TARGETS.providers, false),
  eai_again: () => guide('network', '域名解析暂时失败(EAI_AGAIN)',
    'DNS 查询超时或暂时不可用,通常是本机网络 / 代理的短时故障。',
    '稍后重试;反复出现就检查本机 DNS 与代理设置。',
    TARGETS.settings, false),
  // 只拿到 err_class、没有状态码时的兜底。有状态码时走 byStatus,401 与 403 会被分开说。
  authentication: () => guide('auth', '上游拒绝了凭据或权限',
    '上游没有接受这次请求的身份:可能是 Key 无效,也可能是这个模型 / 路径没有授权,两种从错误类上分不开。',
    '到「渠道与 Key」页核对 Key;若 Key 刚换过,先用同渠道的其它模型试一次,区分"Key 失效"与"模型未授权"。',
    TARGETS.providers, true),
};

// 状态码兜底:先看 401/403/404 这种"状态码本身会说话"的,再用 err_class 兜。
// 顺序是有意的:403 + authentication 要说"权限或风控",不能说成"Key 无效"。
function byStatus(status) {
  if (status === 401) return guide('auth', '凭据被上游拒绝(401)',
    '上游没认出这把 Key:可能过期、被删、粘贴时带了换行,或这把 Key 与账号不匹配。',
    '到「渠道与 Key」页重新粘贴 Key,并确认当前生效账号是该渠道能用的那把。',
    TARGETS.providers, false);
  if (status === 403) return guide('auth', '上游拒绝访问(403)',
    '凭据可能是有效的,但这次请求没有权限:模型 / 路径未授权,或触发上游风控、地区限制。'
    + '它不等于"账号坏了",也不能只凭一个 403 就判定 Key 失效。',
    '先用同渠道的其它模型发一次:同样 403 更像账号权限或风控,只有这个模型 403 更像模型权限;'
    + '再到「渠道与 Key」页核对。',
    TARGETS.providers, true);
  if (status === 404) return guide('model', '上游找不到模型或路径(404)',
    '多数是模型名不在该渠道的支持列表里;少数是协议线的端点不存在(例如把 Claude 请求发给了只有 Chat 端点的渠道)。',
    '到「渠道与 Key」页核对渠道支持的模型;确认模型名后到「路由」页修正规则的模型映射。',
    TARGETS.routes, true);
  if (status === 429) return CLASS_GUIDES.rate_limit();
  if (status === 402) return CLASS_GUIDES.budget_exhausted();
  if (status === 408 || status === 504) return CLASS_GUIDES.timeout();
  if (status === 499) return CLASS_GUIDES.cancelled();
  if (status >= 500) return CLASS_GUIDES.upstream_server();
  if (status >= 400) return guide('request', `上游拒绝了请求内容(${status})`,
    '渠道连通、凭据有效,但这次请求的字段或形状不被接受;具体原因在不同上游之间差别很大。',
    '到「诊断」页对照状态码、模型名与 err_class;换一家渠道重发同样的请求可区分请求问题与渠道挑剔。',
    TARGETS.diagnostics, true);
  if (status >= 200 && status < 400) return null;
  // 没有状态码(连接根本没建立、本地校验失败)时,这里不给结论 —— 交给 err_class / unknown。
  return null;
}

// code 可能是 error.type(no_route_error)、网络错误码(ECONNRESET)或 'HTTP 500'。
// 认不出来不是错:落到状态码 / err_class / unknown。
function explainError(input) {
  const src = input && typeof input === 'object' ? input : {};
  const status = normalizeStatus(src.status);
  const errClass = normalize(src.err_class);
  const code = normalize(src.code);

  if (code && Object.hasOwn(CODE_GUIDES, code)) return CODE_GUIDES[code]();
  if (errClass && Object.hasOwn(CODE_GUIDES, errClass)) return CODE_GUIDES[errClass]();
  if (code && Object.hasOwn(CLASS_GUIDES, code)) return CLASS_GUIDES[code]();
  const fromStatus = byStatus(status);
  if (fromStatus) return fromStatus;
  if (errClass && Object.hasOwn(CLASS_GUIDES, errClass)) return CLASS_GUIDES[errClass]();
  if (status >= 200 && status < 400) {
    return guide('unknown', '这条请求没有失败',
      '给出的状态码是成功区间,没有可解释的失败原因。',
      '如果客户端仍报错,到「诊断」页按 request_id 看这次的终态与尝试过程。',
      TARGETS.diagnostics, true);
  }
  return guide('unknown', '未能归类的失败',
    '没有足够信息判断是渠道、凭据、模型还是网络问题。',
    '到「诊断」页按 request_id 查看这次请求的真实尝试过程与 err_class。',
    TARGETS.diagnostics, true);
}

module.exports = { explainError, CATEGORIES, TARGETS };
