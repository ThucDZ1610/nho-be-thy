const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { askThucGPT, checkOllama, OLLAMA_MODEL } = require('./ThucGPT');

const scryptAsync = promisify(scrypt);
const ROOT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'chats.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const SESSION_COOKIE = 'thucgpt_session';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const DUMMY_PASSWORD_SALT = 'thucgpt-invalid-user-salt';
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let chats = [];
let users = [];
const sessions = new Map();
const failedLoginAttempts = new Map();
let saveQueue = Promise.resolve();
let userSaveQueue = Promise.resolve();

async function loadChats() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    chats = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    if (!Array.isArray(chats)) chats = [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(DATA_FILE, '[]\n', 'utf8');
  }
}

async function loadUsers() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    if (!Array.isArray(users)) users = [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(USERS_FILE, '[]\n', 'utf8');
  }
}

function saveChats() {
  const snapshot = `${JSON.stringify(chats, null, 2)}\n`;
  saveQueue = saveQueue.then(async () => {
    const temporaryFile = `${DATA_FILE}.tmp`;
    await fs.writeFile(temporaryFile, snapshot, 'utf8');
    await fs.rename(temporaryFile, DATA_FILE);
  });
  return saveQueue;
}

function saveUsers() {
  const snapshot = `${JSON.stringify(users, null, 2)}\n`;
  userSaveQueue = userSaveQueue.then(async () => {
    const temporaryFile = `${USERS_FILE}.tmp`;
    await fs.writeFile(temporaryFile, snapshot, 'utf8');
    await fs.rename(temporaryFile, USERS_FILE);
  });
  return userSaveQueue;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name };
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isStrongPassword(password) {
  return typeof password === 'string'
    && password.length >= 12
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

function readCookie(request, name) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : '';
}

function getAuthenticatedUser(request) {
  const token = readCookie(request, SESSION_COOKIE);
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return users.find((user) => user.id === session.userId) || null;
}

function setSessionCookie(request, response, user) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_LIFETIME_MS;
  sessions.set(token, { userId: user.id, expiresAt });
  const secure = request.headers['x-forwarded-proto'] === 'https' || request.socket.encrypted;
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(request, response) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) sessions.delete(token);
  const secure = request.headers['x-forwarded-proto'] === 'https' || request.socket.encrypted;
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
}

function loginIsRateLimited(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const attempt = failedLoginAttempts.get(key);
  if (!attempt || attempt.resetAt <= Date.now()) {
    failedLoginAttempts.set(key, { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS });
    return false;
  }
  return attempt.count >= MAX_LOGIN_ATTEMPTS;
}

function recordLoginFailure(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const attempt = failedLoginAttempts.get(key);
  if (!attempt || attempt.resetAt <= Date.now()) {
    failedLoginAttempts.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  } else {
    attempt.count += 1;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Dữ liệu gửi lên quá lớn (tối đa 14 MB).');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Dữ liệu JSON không hợp lệ.');
    error.statusCode = 400;
    throw error;
  }
}

function cleanImageDataUrl(value) {
  if (typeof value !== 'string' || value.length > 12 * 1024 * 1024) return null;
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : null;
}

function getChatSummary(chat) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messageCount: chat.messages.length
  };
}

async function serveFile(requestPath, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    response.writeHead(400).end('Đường dẫn không hợp lệ.');
    return;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(FRONTEND_DIR, relativePath);
  if (!filePath.startsWith(`${FRONTEND_DIR}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const contents = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(contents);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Không tìm thấy tệp.');
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/health' && request.method === 'GET') {
    try {
      const status = await checkOllama();
      sendJson(response, 200, status);
    } catch {
      sendJson(response, 200, { connected: false, model: OLLAMA_MODEL, modelReady: false });
    }
    return;
  }

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = getAuthenticatedUser(request);
    sendJson(response, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (pathname === '/api/auth/register' && request.method === 'POST') {
    const body = await readJson(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const username = normalizeUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';

    if (name.length < 2 || name.length > 60) {
      sendJson(response, 400, { error: 'Tên hiển thị phải từ 2 đến 60 ký tự.' });
      return;
    }
    if (!/^[a-z0-9_]{4,24}$/.test(username)) {
      sendJson(response, 400, { error: 'Tài khoản phải dài 4-24 ký tự, chỉ gồm chữ không dấu, số hoặc dấu gạch dưới.' });
      return;
    }
    if (password !== body.passwordConfirm) {
      sendJson(response, 400, { error: 'Hai lần nhập mật khẩu chưa khớp.' });
      return;
    }
    if (!isStrongPassword(password)) {
      sendJson(response, 400, { error: 'Mật khẩu cần ít nhất 12 ký tự, có chữ hoa, chữ thường, số và ký tự đặc biệt.' });
      return;
    }
    if (users.some((user) => user.username === username)) {
      sendJson(response, 409, { error: 'Tên tài khoản này đã được sử dụng.' });
      return;
    }

    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scryptAsync(password, salt, 64)).toString('hex');
    const user = { id: randomUUID(), username, name, salt, passwordHash, createdAt: new Date().toISOString() };
    users.push(user);
    await saveUsers();
    setSessionCookie(request, response, user);
    sendJson(response, 201, { user: publicUser(user) });
    return;
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    if (loginIsRateLimited(request)) {
      sendJson(response, 429, { error: 'Quá nhiều lần đăng nhập không thành công. Hãy thử lại sau 15 phút.' });
      return;
    }
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    const user = users.find((item) => item.username === username);
    const candidateHash = await scryptAsync(password, user?.salt || DUMMY_PASSWORD_SALT, 64);
    const expectedHash = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
    const passwordMatches = timingSafeEqual(candidateHash, expectedHash);

    if (!user || !passwordMatches) {
      recordLoginFailure(request);
      sendJson(response, 401, { error: 'Tài khoản hoặc mật khẩu không chính xác.' });
      return;
    }

    failedLoginAttempts.delete(request.socket.remoteAddress || 'unknown');
    setSessionCookie(request, response, user);
    sendJson(response, 200, { user: publicUser(user) });
    return;
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    clearSessionCookie(request, response);
    sendJson(response, 200, { loggedOut: true });
    return;
  }

  const user = getAuthenticatedUser(request);
  if (pathname.startsWith('/api/') && !user) {
    sendJson(response, 401, { error: 'Vui lòng đăng nhập để tiếp tục.' });
    return;
  }

  if (pathname === '/api/chats' && request.method === 'GET') {
    sendJson(response, 200, chats.filter((chat) => chat.userId === user.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(getChatSummary));
    return;
  }

  if (pathname === '/api/chat' && request.method === 'POST') {
    const body = await readJson(request);
    const content = typeof body.content === 'string' ? body.content.trim().slice(0, 12000) : '';
    const image = cleanImageDataUrl(body.image);
    if (!content && !image) {
      sendJson(response, 400, { error: 'Hãy nhập tin nhắn hoặc chọn một hình ảnh.' });
      return;
    }
    if (body.image && !image) {
      sendJson(response, 400, { error: 'Ảnh không hợp lệ hoặc vượt quá dung lượng cho phép.' });
      return;
    }

    let chat = body.chatId ? chats.find((item) => item.id === body.chatId && item.userId === user.id) : null;
    if (body.chatId && !chat) {
      sendJson(response, 404, { error: 'Không tìm thấy cuộc trò chuyện.' });
      return;
    }
    if (!chat) {
      const now = new Date().toISOString();
      chat = { id: randomUUID(), userId: user.id, title: '', createdAt: now, updatedAt: now, messages: [] };
      chats.push(chat);
    }

    const userMessage = {
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      ...(image ? { image } : {})
    };
    chat.messages.push(userMessage);
    if (!chat.title) chat.title = (content || 'Cuộc trò chuyện bằng hình ảnh').slice(0, 56);
    chat.updatedAt = userMessage.createdAt;
    await saveChats();

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.flushHeaders();
    const sendEvent = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    sendEvent({ type: 'start', chat: getChatSummary(chat) });
    const generationController = new AbortController();
    let clientCancelled = false;
    let streamedAnswer = '';
    const generationTimeout = setTimeout(() => generationController.abort(), 180000);
    response.on('close', () => {
      if (!response.writableEnded) {
        clientCancelled = true;
        generationController.abort();
      }
    });

    try {
      const history = chat.messages.slice(-20).map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.image ? { images: [message.image.split(',')[1]] } : {})
      }));
      const onToken = (token) => {
        streamedAnswer += token;
        if (!response.destroyed) sendEvent({ type: 'token', content: token });
      };
      let answer;
      try {
        answer = await askThucGPT(history, onToken, generationController.signal);
      } catch (error) {
        const runnerStopped = /llama-server process has terminated|unexpected EOF/i.test(error.message);
        if (!runnerStopped || streamedAnswer || generationController.signal.aborted) throw error;
        answer = await askThucGPT(history, onToken, generationController.signal);
      }
      const assistantMessage = { role: 'assistant', content: answer, createdAt: new Date().toISOString() };
      chat.messages.push(assistantMessage);
      chat.updatedAt = assistantMessage.createdAt;
      await saveChats();
      sendEvent({ type: 'done' });
      response.end();
    } catch (error) {
      if (streamedAnswer.trim()) {
        const partialMessage = { role: 'assistant', content: streamedAnswer.trim(), createdAt: new Date().toISOString() };
        chat.messages.push(partialMessage);
        chat.updatedAt = partialMessage.createdAt;
        await saveChats();
      }
      if (!clientCancelled && !response.destroyed) {
        sendEvent({ type: 'error', error: `Chưa nhận được phản hồi từ Ollama. ${error.message}` });
        response.end();
      }
    } finally {
      clearTimeout(generationTimeout);
    }
    return;
  }

  const chatMatch = pathname.match(/^\/api\/chats\/([a-f0-9-]+)$/i);
  if (chatMatch && request.method === 'GET') {
    const chat = chats.find((item) => item.id === chatMatch[1] && item.userId === user.id);
    sendJson(response, chat ? 200 : 404, chat || { error: 'Không tìm thấy cuộc trò chuyện.' });
    return;
  }

  if (chatMatch && request.method === 'DELETE') {
    const index = chats.findIndex((item) => item.id === chatMatch[1] && item.userId === user.id);
    if (index === -1) {
      sendJson(response, 404, { error: 'Không tìm thấy cuộc trò chuyện.' });
      return;
    }
    chats.splice(index, 1);
    await saveChats();
    sendJson(response, 200, { deleted: true });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API không tồn tại.' });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('Method not allowed');
    return;
  }
  await serveFile(pathname, response);
}

async function start() {
  await loadChats();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.message || 'Lỗi máy chủ.' });
      else response.end();
    });
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ThucGPT đang chạy tại http://localhost:${PORT}`);
    console.log(`Model Ollama: ${OLLAMA_MODEL}`);
  });
}

start().catch((error) => {
  console.error('Không thể khởi động server:', error);
  process.exitCode = 1;
});
