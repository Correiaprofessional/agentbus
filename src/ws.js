import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;

function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x81; // FIN + text opcode
  return Buffer.concat([header, payload]);
}

function controlFrame(opcode, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/** Decode one frame; null when the buffer does not hold a whole frame yet. */
function decode(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) throw new Error('frame too large');
    length = Number(big);
    offset = 10;
  }
  if (length > MAX_FRAME) throw new Error('frame too large');

  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  let payload = buffer.subarray(offset, offset + length);
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    const out = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }

  return { fin, opcode, payload, text: payload.toString('utf8'), rest: buffer.subarray(offset + length) };
}

/**
 * Complete the WebSocket handshake on an http `upgrade` event.
 *
 * Zero dependencies: the daemon already owns an http server on loopback, so the
 * upgrade is handled in place rather than through a second library.
 */
export function handleUpgrade(req, socket, head, { onMessage, onClose } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay?.(true);

  const client = {
    open: true,
    sessionId: null,
    mode: 'session',
    send(payload) {
      if (!this.open) return false;
      try {
        socket.write(textFrame(typeof payload === 'string' ? payload : JSON.stringify(payload)));
        return true;
      } catch {
        this.terminate();
        return false;
      }
    },
    close(code = 1000) {
      if (!this.open) return;
      this.open = false;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      try {
        socket.write(controlFrame(0x8, payload));
        socket.end();
      } catch {
        /* already gone */
      }
    },
    terminate() {
      this.open = false;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    },
  };

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragment = '';

  const consume = () => {
    for (;;) {
      let parsed;
      try {
        parsed = decode(buffer);
      } catch (err) {
        client.close(1009);
        onClose?.(client);
        return;
      }
      if (!parsed) break;
      buffer = parsed.rest;

      if (parsed.opcode === 0x8) {
        client.close(1000);
        onClose?.(client);
        return;
      }
      if (parsed.opcode === 0x9) {
        try {
          socket.write(controlFrame(0xa, parsed.payload));
        } catch {
          /* ignore */
        }
        continue;
      }
      if (parsed.opcode === 0xa) continue;

      if (parsed.opcode === 0x0) {
        fragment += parsed.text;
        if (parsed.fin) {
          const text = fragment;
          fragment = '';
          onMessage?.(text, client);
        }
        continue;
      }

      if (parsed.opcode === 0x1) {
        if (parsed.fin) onMessage?.(parsed.text, client);
        else fragment = parsed.text;
      }
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    consume();
  });
  socket.on('error', () => onClose?.(client));
  socket.on('close', () => onClose?.(client));

  if (buffer.length) consume();
  return client;
}

/**
 * Client side, using the WebSocket that ships with Node. Returns null when the
 * runtime has none, so callers can fall back to long-polling.
 */
export function connectSocket(url, { onOpen, onEvent, onClose } = {}) {
  if (typeof WebSocket === 'undefined') return null;

  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    return null;
  }

  socket.addEventListener('open', () => onOpen?.(socket));
  socket.addEventListener('message', (event) => {
    try {
      onEvent?.(JSON.parse(String(event.data)));
    } catch {
      /* ignore malformed frames */
    }
  });
  socket.addEventListener('close', () => onClose?.());
  socket.addEventListener('error', () => {
    /* close follows */
  });

  return socket;
}
