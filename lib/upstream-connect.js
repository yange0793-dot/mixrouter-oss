'use strict';

// Per-agent native address selection; never change net's process-wide defaults.
const DIRECT_CONNECT_OPTIONS = Object.freeze({
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 1000,
});

const DEFAULT_CONNECT_TIMEOUT_MS = (() => {
  const raw = process.env.MIXR_UPSTREAM_CONNECT_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === '') return 15000;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= 600000 ? value : 15000;
})();

const guardedSockets = new WeakSet();

// Only initial DNS/TCP/TLS establishment is timed, not inference or stream silence.
function guardConnection(socket, secure, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  if (guardedSockets.has(socket)) return socket;
  guardedSockets.add(socket);
  // TCP can already be connected while TLS is still negotiating/verifying.
  if (socket.destroyed || (secure ? socket.secureConnecting === false : socket.connecting === false))
    return socket;

  const readyEvent = secure ? 'secureConnect' : 'connect';
  let settled = false;
  let timer;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.removeListener(readyEvent, cleanup);
    socket.removeListener('error', cleanup);
    socket.removeListener('close', cleanup);
  };
  socket.once(readyEvent, cleanup);
  socket.once('error', cleanup);
  socket.once('close', cleanup);
  timer = setTimeout(() => {
    if (settled) return;
    cleanup();
    const error = new Error('upstream connection timeout');
    error.code = 'ETIMEDOUT';
    socket.destroy(error);
  }, timeoutMs);
  timer.unref();
  return socket;
}

module.exports = { DIRECT_CONNECT_OPTIONS, DEFAULT_CONNECT_TIMEOUT_MS, guardConnection };
