// 极简 WebSocket 实现（零依赖）
//
// 现状：**仅供自测使用**。生产链路走 OneBot，用的就是 Node 内置的 WHATWG WebSocket，
// 不需要这个模块。这里保留是因为自测要起一个假的 NapCat 服务端，而 Node 没有内置 WS 服务端。
//
// 历史：它当初是为 QQ 官方网关写的——官方网关要求握手时携带 Authorization 等自定义头，
// 而 WHATWG WebSocket 不支持设置 header。官方通道已废弃（见 HANDOFF.md），
// 所以这里现在只剩 wsServe / WsConnection 有实际用途，wsConnect 仅在历史回归中用到。
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode; // FIN=1
  if (!mask) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([head, key, out]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > 64n * 1024n * 1024n) throw new Error('WebSocket 帧超过 64MB 上限');
    len = Number(big);
    off = 10;
  }

  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;

  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, consumed: off + len };
}

/** 一条已升级到 WebSocket 的连接，收发文本帧 */
export class WsConnection extends EventEmitter {
  /** @param {net.Socket} socket @param {{mask:boolean}} opts 客户端发帧必须掩码，服务端不掩码 */
  constructor(socket, { mask }) {
    super();
    this.socket = socket;
    this.mask = mask;
    this.closed = false;
    this._rest = Buffer.alloc(0);
    this._frags = [];

    socket.on('data', (d) => this._feed(d));
    // 没有 'error' 监听者时不要抛出（EventEmitter 默认行为会终止进程），
    // 连接异常本身会通过 'close' 事件体现
    socket.on('error', (e) => {
      if (this.listenerCount('error') > 0) this.emit('error', e);
      else console.error(`[ws] 连接错误：${e.message}`);
    });
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close', 1006, 'socket closed');
      }
    });
  }

  get readyState() {
    return this.closed ? 3 : 1;
  }

  _sendFrame(opcode, payload) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(opcode, payload, this.mask));
    } catch (e) {
      this.emit('error', e);
    }
  }

  send(text) {
    this._sendFrame(OP.TEXT, Buffer.from(String(text), 'utf8'));
  }

  ping(data = Buffer.alloc(0)) {
    this._sendFrame(OP.PING, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason), 'utf8');
    const b = Buffer.alloc(2 + reasonBuf.length);
    b.writeUInt16BE(code, 0);
    reasonBuf.copy(b, 2);
    this._sendFrame(OP.CLOSE, b);
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* 忽略 */
    }
    this.emit('close', code, 'local close');
  }

  _feed(chunk) {
    if (this.closed) return;
    this._rest = this._rest.length ? Buffer.concat([this._rest, chunk]) : chunk;

    for (;;) {
      let f;
      try {
        f = decodeFrame(this._rest);
      } catch (e) {
        this.emit('error', e);
        this.close(1009);
        return;
      }
      if (!f) return;
      this._rest = this._rest.subarray(f.consumed);

      switch (f.opcode) {
        case OP.CONT: {
          this._frags.push(f.payload);
          if (f.fin) {
            const s = Buffer.concat(this._frags).toString('utf8');
            this._frags = [];
            this.emit('message', s);
          }
          break;
        }
        case OP.TEXT:
        case OP.BIN: {
          if (f.fin) this.emit('message', f.payload.toString('utf8'));
          else this._frags = [f.payload];
          break;
        }
        case OP.PING:
          this._sendFrame(OP.PONG, f.payload);
          break;
        case OP.PONG:
          this.emit('pong');
          break;
        case OP.CLOSE: {
          // 必须解析服务端发来的关闭帧：前 2 字节是状态码，其后是原因。
          // 早期版本这里硬编码成 1000，把网关的错误码（4006/4013/4014 等）全吞掉了，
          // 导致故障排查时完全看不到原因。
          let code = 1005;
          let reason = '';
          if (f.payload.length >= 2) {
            code = f.payload.readUInt16BE(0);
            reason = f.payload.subarray(2).toString('utf8');
          }
          const wasClosed = this.closed;
          this.closed = true;
          try {
            this.socket.end();
          } catch {
            /* 忽略 */
          }
          if (!wasClosed) this.emit('close', code, reason || 'remote close');
          return;
        }
        default:
          break;
      }
    }
  }
}

/**
 * 以客户端身份连接 WebSocket，支持自定义握手头。
 * @returns {Promise<WsConnection>}
 */
export function wsConnect(url, headers = {}, { timeoutMs = 20000, rejectUnauthorized } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isTls = u.protocol === 'wss:';
    const port = Number(u.port) || (isTls ? 443 : 80);
    const path = (u.pathname || '/') + (u.search || '');

    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* 忽略 */
      }
      reject(e);
    };

    // 目标为 IP 时不能设 servername（RFC 6066 不允许，Node 会告警）
    const hostIsIp = /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':');
    const socket = isTls
      ? tls.connect({
          host: u.hostname,
          port,
          ...(hostIsIp ? {} : { servername: u.hostname }),
          // 仅在显式传入时才覆盖，默认沿用 Node 的证书校验
          ...(rejectUnauthorized === undefined ? {} : { rejectUnauthorized }),
        })
      : net.connect({ host: u.hostname, port });
    socket.setNoDelay(true);

    const timer = setTimeout(() => fail(new Error(`WebSocket 握手超时(${timeoutMs}ms)：${u.host}`)), timeoutMs);

    const head = [
      `GET ${path} HTTP/1.1`,
      `Host: ${u.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ].join('\r\n') + '\r\n\r\n';

    let buf = Buffer.alloc(0);
    let upgraded = false;

    const onData = (d) => {
      if (upgraded) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) {
        if (buf.length > 65536) fail(new Error('WebSocket 握手响应异常'));
        return;
      }
      const raw = buf.subarray(0, i).toString('latin1');
      const statusLine = raw.split('\r\n')[0];
      if (!/HTTP\/1\.1 101/.test(statusLine)) {
        clearTimeout(timer);
        fail(new Error(`WebSocket 握手被拒绝：${statusLine}`));
        return;
      }
      upgraded = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);

      const conn = new WsConnection(socket, { mask: true });
      const leftover = buf.subarray(i + 4);
      settled = true;
      resolve(conn);
      if (leftover.length) conn._feed(leftover);
    };

    socket.on('data', onData);
    socket.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });

    // 关键：TLS socket 上 'connect'（TCP 就绪）与 'secureConnect'（TLS 握手完成）
    // 会先后各触发一次。早期版本两个都挂了回调，导致 HTTP 升级请求被发送两遍，
    // 第二遍会被对端当作 WebSocket 数据帧解析，报
    // "received header with unexpected rsv bits set"（'G'=0x47 的 RSV1 位为 1）。
    // 这里加一次性开关，两种情形都只发一次。
    let handshakeSent = false;
    const sendHandshake = () => {
      if (handshakeSent || upgraded) return;
      handshakeSent = true;
      socket.write(head);
    };
    if (isTls) socket.on('secureConnect', sendHandshake);
    else socket.on('connect', sendHandshake);
  });
}

/**
 * 起一个最小 WebSocket 服务端，供自测模拟上游。
 * 传 tls: {key, cert} 可起 wss 服务端（用于覆盖 TLS 路径）。
 * @param {(conn: WsConnection, req: http.IncomingMessage) => void} onConn
 * @returns {Promise<{server: http.Server, port: number, close: () => void}>}
 */
export function wsServe(onConn, { host = '127.0.0.1', port = 0, tls: tlsOptions = null } = {}) {
  return new Promise((resolve, reject) => {
    const handler = (req, res) => {
      res.writeHead(426);
      res.end('Upgrade Required');
    };
    const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);

    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${acceptKey(key)}`,
          '',
          '',
        ].join('\r\n')
      );
      socket.setNoDelay(true);
      const conn = new WsConnection(socket, { mask: false });
      onConn(conn, req);
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
