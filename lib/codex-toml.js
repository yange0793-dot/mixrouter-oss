'use strict';
// 出站 TOML 文档的构造与改写 —— **薄适配**。
//
// 这里已经是参数与返回形状的转换层:删 section、顶层键原位替换、转义全部由
// lib/codex-config.js 的 parse/patch/quote 决定,本文件不再有第二份写行算法。
//
// 为什么保留:这些名字有既有调用方(test/modules-wiring.test.js 的 removeOwnSections /
// setTopLevel,test/backup-restore.test.js 的 providerSection),而且它们验的是
// 「删自己的 section、留用户的」「没有才插最前」这几条**契约**;契约不该跟着实现搬家
// 一起消失,所以壳留着,算法只留一份。
//
// buildCodexConfig 与 MIXR_SECTION_RE 目前**没有调用方**(原先用 buildCodexConfig 的
// mixrouter.js writeCodexConfig 已改走 codex-config.patch)。留着它们是因为对外导出面
// 收窄是另一件事,不该混在"合并实现"里顺手做;它们本身就是别名,不构成第二份算法。
const config = require('./codex-config');

// 薄适配层唯一的失效方式是 codex-config 改了导出名而这里没跟上。不检查的话,症状要到
// 第一次调用(写客户端配置那一刻)才出现,失败点离原因很远;这里让它停在 require。
const { removeOwnSections, setTopLevel, providerSection, MIXR_SECTION_RE } = config;
const tomlStr = config.quote;
const codexTopLevel = config.topLevel;
const buildCodexConfig = providerSection;
for (const [name, value] of Object.entries({ removeOwnSections, setTopLevel, providerSection, tomlStr, codexTopLevel })) {
  if (typeof value !== 'function') throw new TypeError(`lib/codex-config.js 未导出 ${name};薄适配层无法工作`);
}

module.exports = { MIXR_SECTION_RE, removeOwnSections, setTopLevel, providerSection, buildCodexConfig, tomlStr, codexTopLevel };
