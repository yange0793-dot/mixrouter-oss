#!/usr/bin/env node
'use strict';
const VERSION = '3.10.0';
const { createApplication } = require('./lib/application');
const application = createApplication({ root: __dirname, version: VERSION });

if (require.main === module) {
  process.title = 'mixrouter';
  process.on('uncaughtException', error => console.error(`[uncaught] ${new Date().toISOString()} ${error.stack || error}`));
  process.on('unhandledRejection', error => console.error(`[unhandled] ${new Date().toISOString()} ${error?.stack || error}`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => application.stopApplication().then(() => process.exit(0)));
  }
  application.startApplication().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = application;
