'use strict';
// TOML 基本字符串 + config.toml 顶层键读取 —— **薄适配**。
//
// 这个文件里已经没有任何解析或转义算法:两个导出都直接指向 lib/codex-config.js。
// 保留这层壳的原因是调用方按这些名字取(mixrouter.js 的导出面、test/helpers.test.js
// 的 tomlStr、test/modules-wiring.test.js 的 tomlLib),换名字要动那些文件与断言;
// 而"只有一份实现"这件事靠这里不再写第二套逻辑来保证,不靠改名字。
//
// 读与写必须是**同一套认法**:顶层键在 codex-config 里由结构化 parse 读、由 patch 写,
// 这里再手写一份正则就会漂移(本轮踩过:缩进顶层键一边认一边不认)。
//
// tomlStr 的契约比旧实现更宽也更准:旧版只转义 \ 和 ",遇到换行/制表符会原样吐进
// 字符串里,写出 `model = "a<换行>b"` 这种非法 TOML;现在统一走 JSON.stringify,
// 换行写成 \n、控制字符有 \u 形式。见 test/codex-config.test.js 的往返断言。
const { quote: tomlStr, topLevel: codexTopLevel } = require('./codex-config');

module.exports = { tomlStr, codexTopLevel };
