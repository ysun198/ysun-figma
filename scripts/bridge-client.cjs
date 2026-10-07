const fs = require('node:fs');

const { connectionPath } = require('./state.cjs');
const { BRIDGE_PROTOCOL_VERSION } = require('../src/core.js');

function validateConnection(connection) {
  const url = new URL(connection.url);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new Error('bridge URL must be a loopback HTTP endpoint');
  if (connection.protocolVersion !== BRIDGE_PROTOCOL_VERSION)
    throw new Error(
      `restart the relay for bridge protocol ${BRIDGE_PROTOCOL_VERSION}`,
    );
}

function readConnection() {
  try {
    const connection = JSON.parse(fs.readFileSync(connectionPath(), 'utf8'));
    if (!connection.url || !connection.token)
      throw new Error('connection file is incomplete');
    validateConnection(connection);
    return connection;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'bridge companion is not running; load ysun figma in Codex',
        { cause: error },
      );
    }
    throw error;
  }
}

async function bridgeRequest(connection, pathname, options = {}) {
  validateConnection(connection);
  if (!pathname.startsWith('/') || pathname.startsWith('//'))
    throw new Error('invalid bridge request path');
  const { timeoutMs = 35000, signal, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(`${connection.url}${pathname}`, {
      ...requestOptions,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
          ])
        : AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(
      `cannot reach the bridge server at ${connection.url}: ${error.message}`,
      { cause: error },
    );
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(
      body.error || `bridge request failed with HTTP ${response.status}`,
    );
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

module.exports = { bridgeRequest, readConnection, validateConnection };
