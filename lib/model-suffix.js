'use strict';
// 出站模型名的 [1M] 后缀。渠道里填的模型名可以带 `[1m]` 后缀,意思是"用 1M 上下文":
// 后缀要从模型名里剥掉(上游只认裸名),同时往**这次出站请求**的头上追加对应的 beta 头。
//
// 两个坑都在调用点上踩过,所以规则写在这里:
//   1) headers 是**传入的对象**,改它就是改出站头;传字面量 {} 进来等于改完即丢。
//      渠道探活那条路径早先就是这么写的(传 `{}`),于是探活发出去的是"裸模型名 + 无 beta 头",
//      而声明了 1m 的上游(anyrouter 的 claude-fable-5-1)对这种请求一律回 400「请启用 1m
//      上下文后重试」。渠道明明能跑真实流量,卡片上却永远挂着那次失败。调用方必须把真头传进来。
//   2) beta 头是**逗号分隔的清单**,不能用 `if (!beta)` 判有无:已经带了别的 beta(比如
//      fine-grained-tool-streaming)时直接覆盖会把人家挤掉;已经带过 1m 时再追加一条重复值。

// 1M 上下文的 beta 头值。Anthropic 侧的固定字符串,不随环境变。
const BETA_1M = 'context-1m-2025-08-07';

// 返回剥掉后缀的模型名;带后缀时**就地**给 headers 合上 beta 头。无后缀则原样返回、不动 headers。
function applyModel(targetModel, headers) {
  let model = String(targetModel || '');
  if (/\[1m\]$/i.test(model)) {
    model = model.replace(/\[1m\]$/i, '');
    const beta = headers['anthropic-beta'];
    headers['anthropic-beta'] = beta
      ? (beta.includes(BETA_1M) ? beta : beta + ',' + BETA_1M)   // 已有清单:已带过就不重复
      : BETA_1M;
  }
  return model;
}

module.exports = { BETA_1M, applyModel };
