'use strict';
// 会话绑定状态(sessions.json)与"这次请求该走哪个渠道"的决定。
//
// **渠道池的运行状态(轮转游标 + 冷却表)已拆到 lib/routing/pool-state.js**:以前
// 绑定表/游标/冷却挤在同一个工厂里,"会话"这个词同时指三件事——用户显式保存的覆盖、
// 代理自动记下的粘性绑定、纯属池子自己的运行时数据。拆开后本模块只管会话,并且
// 通过 getter/setter 保留了 `sess.pools` / `sess.cooldowns` / `resetPools()` 这些旧引用。
//
// **本模块是有状态的**:绑定表跨请求存活,并持有一个 1s 去抖的落盘 timer。
// require 本模块不会读盘或启动服务;createSessionStore() 建立状态,load() 才读盘。
// 用工厂创建,数据文件、TTL、上限、渠道可用性判断都由调用方注入,方便隔离测试。
//
// 粘性语义(与原实现一致):
//   · 手动钉定(pinned)压过策略,连池都不看——钉定的意义就是"这个对话我要它走这里"
//   · 槽位请求(rule.id = slot:*)除外:它只代表这一条请求照槽位表走,不代表对话换了渠道
//   · 否则会话已绑定的渠道仍可用 → 复用;不可用 → 重新挑一个并绑定
//
// 在途请求 guard(第二期 5.2.4):响应回来时那个会话可能已经被手动重绑、解绑、清空或
// 重存了覆盖。captureRequest/settleRequest 用"记录世代"判断这条响应还属不属于当前那条记录:
// 只有仍属同一代的请求才能累加统计与自动落点,没落成的会明说原因(见 settleRequest)。

const { pickMember } = require('../routing/strategy');
const { applyLabel } = require('../session/identity');
const { routingOf, routingRevision, hasRouting, explicitConfig } = require('./session-config');
const { createPoolState } = require('./pool-state');

// 身份只能靠内容指纹或压根没有身份时用的键前缀/键名(lib/session/identity.js 生成)。
// 这类身份会把不同对话并成一条、又会因为提示词变化拆开同一条,所以不允许它们**新建**
// 持久覆盖:存量覆盖照读、照导出、照清理(见 assertRoutingConfigurable)。
const UNSTABLE_KEY_RE = /^(?:fp|cxf):/;
const UNSTABLE_KEYS = ['anon', 'cx-anon'];
const unstableIdentity = key => UNSTABLE_KEY_RE.test(String(key || '')) || UNSTABLE_KEYS.includes(String(key || ''));

// 结算时能写进 actual 的字段。只有请求真的发出去过才会被调用方传进来;
// 这里不存请求正文,也不存任何 Key(只有渠道 ID、模型名、规则 ID 这类标识)。
const ACTUAL_FIELDS = ['providerId', 'model', 'ruleId', 'slot', 'sticky', 'status', 'in', 'out', 'ms'];
// 没有真实请求记录时给控制台的字面量:宁可说"暂无",也不能拿路由预览冒充实际落点。
const ACTUAL_NONE = '暂无';

// 记录世代序号:每条记录第一次被捕获时领一个。只在一个键内部比较,所以进程重启后
// 计数器归零也不会串代。
//
// 世代记在 WeakMap 里,不写进记录对象,有两个实打实的原因:
//   · 记录对象会被写进 sessions.json,也会被 /api/state 与测试的整表替换(含 Object.freeze
//     的夹具)拿到;往记录上挂字段会改到落盘形状,还会在冻结对象上直接抛。
//   · 记录被删/被清之后再建一条,是**另一个对象**,自然拿到新的世代号,不需要显式清理。
let markSeq = 0;
const marks = new WeakMap();
const markOf = s => {
  let m = marks.get(s);
  if (m === undefined) { m = ++markSeq; marks.set(s, m); }
  return m;
};
// 记录当前的"落点签名"。手动钉定/解绑改的就是这几个字段,所以它是"用户有没有手改过绑定"的判据。
// ⚠ 但这几个字段**自动落点也写**(settleRequest 的 binding),所以光比签名分不清"手改"与
// "同一条记录的另一条同代请求刚把落点写进来"——后者会把并发请求的 binding 误判成手改并挡掉。
// bindingsWritten 就是为了把这两种来源分开(见 settleRequest)。
const bindingSig = s => [s.providerId || '', s.model || '', s.ruleId || '', s.pinned ? 1 : 0].join('\u0000');
// 记录对象 → 本进程**经 settleRequest 写进去的**那组绑定值。只在内存里,不落盘、不进记录字段。
// 有了它,"用户手改"= 当前值 ≠ 我们写进去的值(或我们从没写过),不再依赖会自我失效的签名快照。
const bindingsWritten = new WeakMap();

// deps: { sessionsFile, ttlMs, max, loadJson, saveJson, storeOf, providerEligible, now? }
//   storeOf(app)           → 该组的渠道数组
//   providerEligible(id)   → 该渠道当前是否可用(健康 + 不在冷却)
//   poolState              → 可选的池运行状态实例(不传就自己建一个,门面接口不变)
function createSessionStore(deps) {
  const { sessionsFile, ttlMs, max, loadJson, saveJson, storeOf, providerEligible } = deps;
  const now = deps.now || (() => Date.now());
  const pool = deps.poolState || createPoolState({ cooldownMs: deps.cooldownMs, now });

  let sessions = new Map();

  function load() {
    const raw = loadJson(sessionsFile, null);
    const list = (raw && raw.bindings) || {};
    sessions = new Map(Object.entries(list));
    return sessions;
  }

  let dirty = false, timer = null;
  // 去抖落盘失败时的出口。默认打到 stderr,调用方(常驻进程)可以换成自己的日志格式。
  // 由调用方注入而不在这里直接 console.error:本模块是库,顶层不该决定日志长什么样。
  const reportSaveError = deps.onSaveError || (e => console.error(`[sessions] 会话绑定落盘失败: ${(e && e.message) || e}`));
  // 立即落盘。退出路径要走这个:写盘有 1s 去抖,进程一退,窗口内的绑定就丢了
  //
  // ⚠ dirty 只能在**写成功之后**清。以前是 `dirty = false; saveJson(...)` —— 顺序反了:
  // 写失败时这次改动已经被记成"落过盘"了,之后再也不会被重试,而内存里那份改动还在,
  // 于是"控制台看着改了、重启就变回去"。实测(探针让原子替换抛 EACCES):
  // 第一次 flush 抛错后,手动再 flush 一次也不写任何东西 —— 这份改动永远不会落盘。
  //
  // force:调用方**确知**内存已经和盘上不一致时用(控制台的会话清空/钉定/解绑三扇门)。
  // 不能只靠 dirty 判:那个标记只由 saveSoon() 点亮,而这三次改动走的是各自的接口,
  // 未必刚有过一次请求去点亮它。实测:清空会话后 dirty 仍是 false,
  // flush 直接早退,接口回 200、内存空了、盘上一条不少。
  function flush(force = false) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty && !force) return;
    const bindings = {};
    for (const [k, v] of sessions) bindings[k] = v;
    saveJson(sessionsFile, { version: 1, bindings }); // 抛就让它抛:关停路径(onFlush)要能看见这次没落成
    dirty = false;
  }
  function saveSoon() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { flush(); }
      catch (e) {
        // 去抖落盘是**后台**动作,没人接得住它抛的错:让它冒出去就是一个 uncaughtException
        // (实测:进程还在跑,这次改动却再也不会落盘,而且没有任何提示)。
        // 如实报出去,并让 dirty 留在 true —— 下一次自然落盘(下一次 saveSoon,或关停时的
        // flushSessions)会把它带上。
        //
        // 这里**不自动重排定时器**:落盘失败多半是磁盘满/权限这类持续性故障,
        // 一秒一次的重试只是把日志刷满,并不会让它成功。真要看住它会一直失败,
        // 该由调用方在 reportSaveError 里做,不该由库偷偷空转。
        reportSaveError(e);
      }
    }, 1000);
    if (timer.unref) timer.unref();
  }

  // 显式配置 = 有 Key/槽位覆盖(routing)或手动钉定(pinned)。自动粘性绑定两者都不是。
  // TTL 与容量只回收**自动**记录:用户存过的东西不能因为闲置 12 小时或表满被悄悄丢掉。
  // 判据在 lib/routing/session-config.js(explicitConfig),与诊断预览共用同一份。

  function prune() {
    const t = now();
    for (const [k, v] of sessions) if (!explicitConfig(v) && t - (v.lastUsed || 0) > ttlMs) sessions.delete(k);
    while (sessions.size > max) {
      let oldestK = null, oldest = Infinity;
      for (const [k, v] of sessions) if (!explicitConfig(v) && (v.lastUsed || 0) < oldest) { oldest = v.lastUsed || 0; oldestK = k; }
      if (oldestK === null) break;
      sessions.delete(oldestK);
    }
    pool.pruneCooldowns();
  }

  function configuredCount() {
    let count = 0;
    for (const session of sessions.values()) if (explicitConfig(session)) count++;
    return count;
  }
  function assertRoutingCapacity(key, routing) {
    const limit = deps.maxConfigured === undefined ? max : deps.maxConfigured;
    if (hasRouting({ routing }) && !hasRouting(sessions.get(key)) && configuredCount() >= limit)
      throw Object.assign(new Error('已配置会话数量达到上限，请先清除不再使用的会话配置'), { statusCode: 400 });
  }
  // 低可信身份(内容指纹 / 匿名)不能**新建**持久覆盖:同 system+首条用户文本会把不同对话
  // 并成一条,提示一变又会把同一条拆开,存下来的键/槽位会串到别的对话上。
  // 只拦"新建":idle 之前存过的覆盖照读、照导出、照清理,不静默删除也不转绑。
  function assertRoutingConfigurable(key, routing) {
    if (!hasRouting({ routing })) return;
    const key_ = String(key || '');
    if (!unstableIdentity(key_)) return;
    if (hasRouting(sessions.get(key_))) return;   // 存量覆盖:允许继续编辑/清空
    throw Object.assign(new Error(
      '这条会话是按内容指纹/匿名识别的，无法可靠地分开不同对话，不能新建会话级渠道/Key 覆盖；' +
      '请让客户端带上会话 ID 头(Claude Code 的 x-claude-code-session-id / Codex 的 session-id)再配置'),
    { statusCode: 400 });
  }

  function markCooldown(providerId) { pool.markCooldown(providerId); }
  const inCooldown = id => pool.inCooldown(id);

  // 某渠道当前挂了几个活跃会话(least_used 用)。
  // ⚠ 口径是"绑定到该渠道的会话条数",不是在途请求数、token 或成本。
  function activeCount(providerId) {
    let n = 0;
    for (const v of sessions.values()) if (v.providerId === providerId) n++;
    return n;
  }

  // 拿到本会话该走的渠道:已有绑定且渠道仍可用 → 复用(粘性);否则挑一个并绑定
  // fallbackStrategy 仅供日志兜底无规则对象时使用(default 路由也能带上配置的策略)
  function resolveTarget(rule, members, key, label, kind, app = 'claude', fallbackStrategy) {
    const effectiveRule = rule || { id: 'default', strategy: fallbackStrategy };
    prune();
    const t = now();
    const bound = sessions.get(key);
    const touch = () => { bound.lastUsed = t; applyLabel(bound, label); };
    // 槽位请求(别名 mixr-*)只代表"这一条请求"照槽位表走,不代表对话换了渠道:
    // 手动钉定与对话粘性都不该劫持它,否则备池会沿用对话渠道而跳过槽位自己的策略。
    const slotRequest = String((rule && rule.id) || '').startsWith('slot:');
    if (bound) {
      // 手动钉定压过策略:哪怕这个渠道不在池里也照走——钉定的意义就是"这个对话我要它走这里"
      if (bound.pinned && !slotRequest) {
        const p = storeOf(app).find(x => x.id === bound.providerId);
        if (p && p.enabled !== false && providerEligible(bound.providerId)) {
          touch();
          return { member: { provider: p, model: bound.model || (rule && rule.model) || '', weight: 1 }, sticky: true, rebind: false };
        }
      }
      const m = members.find(x => x.provider.id === bound.providerId);
      if (m && !slotRequest && providerEligible(bound.providerId)) {
        touch();
        return { member: m, sticky: true, rebind: false };
      }
    }
    const picked = pickMember(effectiveRule, members, { eligible: providerEligible, activeCount, pools: pool.pools });
    return { member: picked, sticky: !slotRequest && !!bound, rebind: !slotRequest };
  }

  function entry(key, kind, label, app = 'claude') {
    let s = sessions.get(key);
    if (!s) {
      s = { app, providerId: '', model: '', ruleId: '', label: label || '', kind, created: now(), lastUsed: now(), reqs: 0, inTok: 0, outTok: 0, pinned: false };
      sessions.set(key, s);
    }
    if (kind && s.kind !== kind) s.kind = kind;
    if (!s.app) s.app = app;
    applyLabel(s, label);
    return s;
  }

  // ---------------------------------------------------------------- 在途请求 guard
  // 控制台的三扇门(保存覆盖 / 钉定 / 解绑)都是**整条换掉**记录对象(见 console.js 的
  // mutateSessions 注释:原地改会让落盘失败时的回滚退不回原对象)。换对象之后,在途响应
  // 拿的还是旧对象,光比对象身份会把"用户改配置"误判成"记录已删后重建"——于是这条请求的
  // 统计被整条丢掉。这里把世代显式交给新记录:只有"删掉之后重新建档"才换新代(entry 里
  // 必然是另一个键下/已不存在的记录,不会走到这条路径)。
  function carryMark(from, key) {
    const to = sessions.get(String(key));
    if (!from || !to || from === to) return to;
    const mark = marks.get(from);
    if (mark !== undefined) marks.set(to, mark);
    // bindingsWritten 也要跟着交:它是"我们上次写进去的绑定值",记在对象上。
    // 不交的话,换对象之后新对象没有条目 → 基准退回入口快照 → 一条在保存覆盖前就已落账的
    // 同代请求(仍在途)回来时,当前值 ≠ 它自己的快照,会被误判成"用户手改"而丢掉落点。
    // 保存覆盖本来就不改绑定,这里不该拦。
    const written = bindingsWritten.get(from);
    if (written !== undefined) bindingsWritten.set(to, written);
    return to;
  }

  // 捕获"这一条请求开始时的会话代"。返回的令牌只是快照,不改任何状态——
  // 同一条记录的多个并发请求各拿各的令牌,彼此不会作废(见 settleRequest 的判定)。
  //
  // ⚠ 调用点必须在会话记录**已经存在**之后(即 sessionEntry 之后):记录不存在时捕获到的
  // 令牌 seal 为 no-record,之后任何结算都不会写——否则请求会替一条并不存在的记录建档。
  //
  // 令牌 = { key, mark, sig, missing }。sig 是**捕获那一刻**的落点签名,但它只在"这条记录
  // 自从捕获以来还没被任何一次结算写过"时用作基准(见 settleRequest):一旦有结算写过,
  // 基准就换成"我们上次写进去的值",所以并发的同代请求不会把彼此误判成"用户手改"。
  // 令牌保持不透明:调用方只负责捕获、透传、结算,不读它的字段。
  function captureRequest(key) {
    const s = sessions.get(String(key));
    if (!s) return { key: String(key), mark: null, sig: '', missing: true };
    return { key: String(key), mark: markOf(s), sig: bindingSig(s), missing: false };
  }

  // 结算:把本次请求的真实结果写回会话记录。字段都是可选的,**按批更新**:
  //   usage:   { in, out }                               → 累加 reqs/inTok/outTok(并顺带刷 lastUsed)
  //   binding: { providerId, model, ruleId }             → 自动落点绑定
  //   actual:  { providerId, model, ruleId, slot, sticky, status, in, out, ms }
  //                                                      → 最近一次真实落点(与绑定分开存放)
  //
  // 判定(按代):
  //   · 记录已被删除 → 什么都不写(不复活)
  //   · 该键下已经是**另一条记录**(删掉后重建)→ 什么都不写(旧响应不能改新记录)
  //   · 同一条记录,但期间**用户手改过**绑定(钉定/解绑/重绑)→ usage/actual 照记
  //     (它们描述的是这条会话真实发生过的事,不碰任何配置),**binding 不写**——
  //     否则刚钉好的渠道会被在途响应覆盖回去
  // 返回 { ok, applied:{usage,binding,actual}, reason, binding_blocked }:
  //   reason          '' | 'no-record' | 'removed' | 'replaced'
  //   binding_blocked '' | 'binding-changed'
  //
  // 已知局限(说清楚,不假装它拦得住每一种交错):"手改"是靠**当前值**判的,没有版本号,
  // 所以下面的时序拦不住——A 结算写 binding(t1),用户立即手改(钉定/解绑),B 再结算(t2,t3 之后):
  // B 拿到的是"用户改过的值"这个**当前状态**,会照常把绑定写回去。触发条件是同一会话
  // 两条请求真的并发、且用户恰在两次结算的窗口里手改;两条同代请求的顺序**不影响**判定
  // (先返回的那条不会把后返回的那条误判成手改,这一点由 bindingsWritten 保证)。
  // 要彻底关掉这个窗口,需要"写入者版本 + 用户改动版本"的乐观并发(与保存覆盖的 expected_revision
  // 同形),那是一次接口扩展,不在本期范围。
  // 同一令牌可以结算多次(落点一次、收尾一次),每次只处理本次传入的字段;
  // 重复累加由调用方的终态幂等守卫负责(现有的 finalized 标志就是)。
  function settleRequest(token, patch = {}) {
    const out = { ok: false, applied: { usage: false, binding: false, actual: false }, reason: '', binding_blocked: '' };
    if (!token || typeof token !== 'object') { out.reason = 'no-record'; return out; }
    if (token.missing) { out.reason = 'no-record'; return out; }
    const s = sessions.get(token.key);
    if (!s) { out.reason = 'removed'; return out; }
    if (markOf(s) !== token.mark) { out.reason = 'replaced'; return out; }
    out.ok = true;

    const usage = patch.usage && typeof patch.usage === 'object' ? patch.usage : null;
    if (usage) {
      s.reqs = (s.reqs || 0) + 1;
      s.inTok = (s.inTok || 0) + (Number(usage.in) || 0);
      s.outTok = (s.outTok || 0) + (Number(usage.out) || 0);
      s.lastUsed = now();
      out.applied.usage = true;
    }

    const actual = patch.actual && typeof patch.actual === 'object' ? patch.actual : null;
    if (actual) {
      const prev = s.actual && typeof s.actual === 'object' ? s.actual : {};
      const next = { ...prev };
      for (const f of ACTUAL_FIELDS) if (actual[f] !== undefined) next[f] = actual[f];
      next.ts = now();
      s.actual = next;
      out.applied.actual = true;
    }

    const binding = patch.binding && typeof patch.binding === 'object' ? patch.binding : null;
    if (binding) {
      // 只在"用户手改过这条记录的绑定"时拦。**不按 routing 判**:存一份 Key/槽位覆盖不改变
      // 这个对话该走哪个渠道,自动绑定照常该记——否则跨过"保存覆盖"那一刻的在途请求,
      // 恰恰会把这条本该记下的粘性绑定丢掉(粘性静默失效,而路由预览与实跑会一致地跟着走偏)。
      //
      // **钉定(显式配置)一律不回写**:手动钉定是用户存下来的要求,自动落点是无主的推断,
      // 后者不该覆盖前者。规划 5.2.4 只允许更新"统计**或自动绑定**",钉定不属于自动绑定;
      // 5.2.5 与 explicitConfig=pinned||hasRouting 又要求显式设置不能被静默丢弃。
      // 不回写的代价不是"少记一条",而是**钉定被永久废掉**:钉定 X → X 一次冷却/5xx →
      // 请求回退到 Y 并把 binding 写回 → 记录变成 {providerId:Y, pinned:true} →
      // resolveTarget 的钉定分支读的是 bound.providerId(现在是 Y),X 恢复后下一条仍粘 Y。
      // 用户钉的 X 再也回不来,而界面还显示"已钉定"。一次 500 就能触发。
      // actual 照记(上面那一段在它之前就写完了),所以"最近实际落到哪"在控制台仍然看得到,
      // 三层状态不丢信息——钉定那层说"要求是 X",actual 那层说"这一条实际落到 Y"。
      if (s.pinned) {
        // 取值复用 binding-changed(不加新枚举,旧消费者不必改):含义是"这条记录的绑定
        // 属于显式配置,自动落点不得回写",不表示"用户刚刚改过"。
        out.binding_blocked = 'binding-changed';
        return out;
      }
      // 判"手改"的基准分两种,这是关键:
      //   · 这条记录**自从捕获以来还没被任何结算写过** → 基准 = 入口快照 sig(捕获时看到的值);
      //   · 已经被写过 → 基准 = 我们上次写进去的值。
      // 只用入口快照当基准会在**并发的同代请求**上出错:第一条响应写进落点之后,记录签名就不再
      // 等于自己的快照,后回来的那条会被误判成"用户手改"而丢掉自己本该记下的落点(失败转移换
      // 渠道时两条会落到不同渠道)。反过来,若一律只认"上次写进去的值",就分不清"用户手改成
      // 新值"和"用户改回我们写过的旧值"——留 sig 作为"从没写过"时的基准,一次手改也不会漏。
      const written = bindingsWritten.get(s);
      const baseline = written ? written.sig : token.sig;
      if (bindingSig(s) !== baseline) out.binding_blocked = 'binding-changed';
      else {
        if (binding.providerId !== undefined) s.providerId = String(binding.providerId || '');
        if (binding.model !== undefined) s.model = String(binding.model || '');
        if (binding.ruleId !== undefined) s.ruleId = String(binding.ruleId || '');
        bindingsWritten.set(s, { sig: bindingSig(s) });
        out.applied.binding = true;
      }
    }
    return out;
  }

  // 控制台用:当前活跃会话一览(不含任何密钥;key 只给短 id 便于对照日志)
  //
  // 三层状态分开给,不混成一个"已绑定":
  //   required —— 用户存下来的要求(渠道级 Key / 槽位覆盖 + revision)
  //   bound    —— 当前绑定(手动钉定或代理自动粘性)
  //   actual   —— 最近一次**真实请求**的落点与结果;没有请求记录时 actual 为 null
  //              且 actual_text 就是「暂无」,绝不拿路由预览冒充实际落点
  function list({ findProvider, short }) {
    prune();
    const out = [];
    for (const [k, v] of sessions) {
      const p = v.providerId ? findProvider(v.providerId) : null;
      const routing = routingOf(v);
      const a = v.actual && typeof v.actual === 'object' ? v.actual : null;
      const ap = a && a.providerId ? findProvider(a.providerId) : null;
      const actual = an => ({
        provider: a.providerId || '', provider_name: ap ? ap.name : '', model: a.model || '',
        rule: a.ruleId || '', slot: a.slot || '', sticky: !!a.sticky, status: a.status || 0,
        in: a.in || 0, out: a.out || 0, ms: a.ms || 0, ts: a.ts || 0, ...an,
      });
      out.push({ key: k, short: short(k), app: v.app || 'claude', kind: v.kind || '', label: v.label || '',
        provider: v.providerId || '', provider_name: p ? p.name : '', model: v.model || '',
        rule: v.ruleId || '', reqs: v.reqs || 0, inTok: v.inTok || 0, outTok: v.outTok || 0,
        created: v.created || 0, lastUsed: v.lastUsed || 0, pinned: !!v.pinned,
        cooldown: !!v.providerId && inCooldown(v.providerId),
        routing, routing_revision: routingRevision(v.routing),
        // 结构化三层(第二期 5.2.7)。旧字段原样保留,供旧控制台过渡。
        configured: explicitConfig(v),
        required: { routing, revision: routingRevision(v.routing),
          keys: Object.keys(routing.keys).length, slots: Object.keys(routing.slots).length },
        bound: { provider: v.providerId || '', provider_name: p ? p.name : '', model: v.model || '',
          rule: v.ruleId || '', pinned: !!v.pinned,
          source: !v.providerId ? 'none' : (v.pinned ? 'manual' : 'auto') },
        actual: a ? actual() : null,
        actual_source: a ? 'request' : 'none',
        actual_text: a ? (ap ? ap.name : (a.providerId || ACTUAL_NONE)) : ACTUAL_NONE });
    }
    return out.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  }

  // 测试接口用:整份替换绑定表。冷却表/游标是分开的状态,这里的替换不动它们
  function replaceBindings(v) {
    if (!(v instanceof Map)) {
      throw new TypeError('sessions 必须是 Map(整份替换绑定表请用 Map);若要改冷却表请用 cooldowns setter');
    }
    sessions = v;
  }

  return {
    load, flush, saveSoon, prune, markCooldown, inCooldown, activeCount,
    resolveTarget, entry, list, replaceBindings, configuredCount,
    assertRoutingCapacity, assertRoutingConfigurable,
    captureRequest, settleRequest, carryMark,
    get sessions() { return sessions; },
    // 整份替换绑定表(测试用)。只接受 Map——传对象会静默把绑定表清空,
    // 而控制台的会话列表会跟着空掉,看不出是"替换失败"还是"真没有会话"。
    set sessions(v) { replaceBindings(v); },
    // 池运行状态(轮转游标 / 冷却表)已搬到 lib/routing/pool-state.js。
    // 下面这几个**必须是 getter/setter**:resetPools() 会整份换掉那个对象,
    // 快照下来的引用会在重置后指向旧表。
    get cooldowns() { return pool.cooldowns; },
    set cooldowns(v) { pool.cooldowns = v; },
    get pools() { return pool.pools; },
    resetPools() { pool.resetPools(); },
  };
}

module.exports = { createSessionStore, ACTUAL_NONE, unstableIdentity };
