#!/usr/bin/env node
// RDrive Model Context Protocol (MCP) stdio entrypoint for AI agents (Claude Desktop, Antigravity, Cursor, etc.).
// Requires a per-individual Personal Agent Token (RDRIVE_TOKEN=rdrive_pat_...).
//
// Can run in two ways:
// 1. Remote mode (when RDRIVE_URL is set, e.g. https://my-drive.tailnet.ts.net):
//    Forwards MCP JSON-RPC requests over HTTPS to `${RDRIVE_URL}/mcp` with `Authorization: Bearer ${RDRIVE_TOKEN}`.
// 2. Local mode (when running on the computer hosting rdrive):
//    Verifies RDRIVE_TOKEN against RDRIVE_DATA (default ./data) and runs the scoped MCP server directly.
const path = require('node:path');
const readline = require('node:readline');
const { Auth } = require('./lib/auth');
const { Files } = require('./lib/files');
const { Shares } = require('./lib/shares');
const { McpServer } = require('./lib/mcp');

const TOKEN = (process.env.RDRIVE_TOKEN || '').trim();
const REMOTE_URL = (process.env.RDRIVE_URL || '').trim().replace(/\/+$/, '');
const DATA_DIR = path.resolve(process.env.RDRIVE_DATA || path.join(__dirname, 'data'));

if (!TOKEN || !TOKEN.startsWith('rdrive_pat_')) {
  process.stderr.write(
    'Error: RDRIVE_TOKEN environment variable must be set to a personal agent token (rdrive_pat_...).\n' +
      'Create one in RDrive: click your username -> AI Agents (MCP) -> Create token.\n'
  );
  process.exit(1);
}

let localMcp = null;
let localAuth = null;

if (!REMOTE_URL) {
  localAuth = new Auth(DATA_DIR);
  const files = new Files(DATA_DIR);
  const shares = new Shares(DATA_DIR);
  localMcp = new McpServer({ auth: localAuth, files, shares });
}

async function dispatchMessage(msg) {
  if (REMOTE_URL) {
    const res = await fetch(`${REMOTE_URL}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(msg),
    });
    if (res.status === 202 || res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      return {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: -32001, message: `RDrive MCP HTTP ${res.status}: ${text}` },
      };
    }
    return text ? JSON.parse(text) : null;
  }

  // Re-read tokens on each request so revocations in the web app take effect immediately.
  localAuth = new Auth(DATA_DIR);
  const tokenInfo = localAuth.verifyAgentToken(TOKEN, 'stdio');
  if (!tokenInfo) {
    if (msg.id === undefined) return null;
    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32001, message: 'Invalid, expired, or revoked RDRIVE_TOKEN.' },
    };
  }
  return await localMcp.handleJsonRpc(tokenInfo, msg);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'
    );
    return;
  }

  try {
    if (Array.isArray(parsed)) {
      const results = (await Promise.all(parsed.map(dispatchMessage))).filter(Boolean);
      if (results.length) process.stdout.write(JSON.stringify(results) + '\n');
    } else {
      const reply = await dispatchMessage(parsed);
      if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
    }
  } catch (err) {
    if (parsed && parsed.id !== undefined) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32603, message: err.message } }) + '\n'
      );
    }
  }
});
