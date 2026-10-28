'use strict';
// 通用校验小工具:只放被多个模块共用、且与任何客户端无关的判断。
//
// 为什么单列:这两个函数原本长在 lib/zcode-config.js 里,被路由层(slots)与 HTTP 层
// (console)当作公共依赖直接 require。ZCode 接入被移除后,它们不该跟着那份客户端配置
// 模块一起消失 —— 但也不该再让通用功能反向依赖某个客户端的模块。
// 语义与原先逐字一致:invalid() 造的 Error 带 statusCode 400,HTTP 出口按它定状态码。

const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

module.exports = { invalid, isObject };
