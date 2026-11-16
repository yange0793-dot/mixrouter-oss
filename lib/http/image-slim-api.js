'use strict';
const fs = require('node:fs');
const { writeJsonAtomic } = require('../atomic-write');
const { invalid, isObject } = require('../validation');
const { isJsonRequest } = require('./local-access');
const { DEFAULT_SETTINGS, slimImages } = require('../image-slim');

function validateSettings(input) {
  if (!isObject(input)) throw invalid('图片精简设置必须是对象');
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw invalid(`未知图片精简设置: ${key}`);
    if (key === 'enabled' || key === 'attachments') {
      if (typeof value !== 'boolean') throw invalid(`${key} 必须是布尔值`);
    } else {
      const max = key === 'min_bytes' ? 2147483647 : 1000;
      if (!Number.isSafeInteger(value) || value < 0 || value > max)
        throw invalid(`${key} 必须是 0 到 ${max} 之间的整数`);
    }
  }
  return input;
}

function createImageSlimApi({ file }) {
  let settings = { ...DEFAULT_SETTINGS };
  const stats = { requests: 0, images_removed: 0, bytes_saved: 0 };
  try {
    settings = { ...settings, ...validateSettings(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return {
    slim(body, protocol) {
      const result = slimImages(body, protocol, settings);
      if (result.images_removed) {
        stats.requests++;
        stats.images_removed += result.images_removed;
        stats.bytes_saved += result.bytes_saved;
      }
      return result;
    },
    async handler({ req, url, readObject, send }) {
      if (url.pathname !== '/api/image-slim') return false;
      if (req.method !== 'GET' && req.method !== 'PUT') return false;
      if (req.method === 'PUT') {
        if (!isJsonRequest(req)) {
          send(415, { error: 'Content-Type 必须是 application/json' });
          return true;
        }
        const input = validateSettings(await readObject());
        const next = { ...settings, ...input };
        writeJsonAtomic(file, next);
        settings = next;
      }
      send(200, { settings: { ...settings }, stats: { ...stats } });
      return true;
    },
  };
}

module.exports = { createImageSlimApi };
