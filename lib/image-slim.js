'use strict';

// Adapted from euanguo/magpie-middleware-image-slim, Copyright (c) 2026 Euan Guo.
// Upstream: https://github.com/euanguo/magpie-middleware-image-slim
// MIT license: ../docs/licenses/image-slim-MIT.txt

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  keep_last: 0,
  keep_last_turns: 1,
  min_bytes: 8192,
  attachments: true,
});

function toolInfo(name, args) {
  const info = { name: typeof name === 'string' ? name : '', path: '' };
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return info; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return info;
  for (const key of ['path', 'file_path', 'image_path', 'screenshot_path', 'filename', 'file']) {
    const path = args[key];
    if (typeof path !== 'string' || !path.trim()) continue;
    // A URL in a tool's arguments is not evidence of a local file.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) continue;
    info.path = path;
    break;
  }
  return info;
}

function imageBytes(part, protocol, isTool) {
  if (!part || part.file_id != null) return 0;
  if (protocol === 'anthropic' || protocol === 'responses' && isTool && part.type === 'image') {
    if (part.type !== 'image') return 0;
    const source = part.source;
    const data = source?.type === 'base64' ? source.data
      : protocol === 'responses' && !source ? part.data : null;
    const mime = source?.type === 'base64' ? source.media_type : part.mimeType || part.media_type;
    return typeof data === 'string' && typeof mime === 'string' && /^image\/[a-z0-9.+-]+$/i.test(mime)
      ? Buffer.byteLength(data, 'utf8') : 0;
  }
  if (part.type !== 'image_url' && !(protocol === 'responses' && part.type === 'input_image')) return 0;
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url !== 'string') return 0;
  const prefix = /^data:image\/[a-z0-9.+-]+(?:;[^;,]*)*;base64,/i.exec(url);
  return prefix ? Buffer.byteLength(url.slice(prefix[0].length), 'utf8') : 0;
}

function placeholder(info) {
  const source = info ? `tool ${info.name || '(unknown)'}` : 'message attachment';
  let text = `[Historical image omitted. Source: ${source}.`;
  if (info?.path) {
    text += ` Local path: ${JSON.stringify(info.path)}.`;
    if (/(?:^|[._])Read$/.test(info.name)) text += ` Use ${info.name} to read it again if needed.`;
    else if (/(?:^|[._])view_image$/.test(info.name)) text += ` Use ${info.name} to view it again if needed.`;
    else text += ' Read this local file again if needed.';
  } else {
    text += ' No local path is available;';
    text += info ? ' rerun the original tool if needed.' : ' ask the user to attach it again if needed.';
  }
  return text + ']';
}

function slimImages(body, protocol, settings) {
  const stats = { images_total: 0, images_removed: 0, bytes_saved: 0 };
  if (!settings.enabled) return stats;
  if (!['anthropic', 'responses', 'chat'].includes(protocol)) return stats;
  const items = protocol === 'responses' ? body?.input : body?.messages;
  if (!Array.isArray(items)) return stats;

  const calls = new Map();
  for (const item of items) {
    if (protocol === 'responses') {
      if ((item?.type === 'function_call' || item?.type === 'custom_tool_call') && item.call_id) {
        calls.set(item.call_id, toolInfo(item.name, item.type === 'custom_tool_call' ? item.input : item.arguments));
      }
    } else if (item?.role === 'assistant') {
      if (protocol === 'anthropic' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === 'tool_use' && part.id) calls.set(part.id, toolInfo(part.name, part.input));
        }
      } else if (protocol === 'chat' && Array.isArray(item.tool_calls)) {
        for (const call of item.tool_calls) {
          if (call?.id && call.type === 'function') {
            calls.set(call.id, toolInfo(call.function?.name, call.function?.arguments));
          }
        }
      }
    }
  }

  const images = [], turns = [];
  const collect = (content, index, info = null) => {
    if (!Array.isArray(content)) return;
    for (let at = 0; at < content.length; at++) {
      const part = content[at];
      if (protocol === 'anthropic' && !info && part?.type === 'tool_result') {
        collect(part.content, index, calls.get(part.tool_use_id) || { name: '', path: '' });
        continue;
      }
      const bytes = imageBytes(part, protocol, info !== null);
      if (bytes) images.push({ content, at, index, info, bytes });
    }
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;
    if (protocol === 'responses') {
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const content = Array.isArray(item.output) ? item.output : item.output?.content;
        collect(content, index, calls.get(item.call_id) || { name: '', path: '' });
        continue;
      }
      if (item.type !== undefined && item.type !== 'message') continue;
    }
    if (!['user', 'assistant', 'system', 'developer', ...(protocol === 'chat' ? ['tool'] : [])].includes(item.role)) continue;
    const content = item.content;
    // Tool-only user messages continue the current turn. An image-only user
    // message starts a turn just as a text message does.
    if (item.role === 'user' && (typeof content === 'string' && content.length > 0
        || Array.isArray(content) && content.some(part => part && (protocol !== 'anthropic' || part.type !== 'tool_result')))) {
      turns.push(index);
    }
    collect(content, index, item.role === 'tool'
      ? calls.get(item.tool_call_id) || toolInfo(item.name, null) : null);
  }

  stats.images_total = images.length;
  // Incremental requests may contain only tool outputs. Without a user turn
  // anchor, none of their images are known to belong to completed history.
  if (!turns.length) return stats;
  const floor = turns[Math.max(0, turns.length - settings.keep_last_turns - 1)];
  const newest = images.length - settings.keep_last;
  for (let n = 0; n < images.length; n++) {
    const image = images[n];
    if (image.index >= floor || n >= newest || image.bytes < settings.min_bytes
        || !settings.attachments && !image.info) continue;
    const before = image.content[image.at];
    const after = {
      type: protocol === 'responses' ? 'input_text' : 'text',
      text: placeholder(image.info),
    };
    stats.bytes_saved += Buffer.byteLength(JSON.stringify(before), 'utf8') - Buffer.byteLength(JSON.stringify(after), 'utf8');
    image.content[image.at] = after;
    stats.images_removed++;
  }
  return stats;
}

module.exports = { DEFAULT_SETTINGS, slimImages };
