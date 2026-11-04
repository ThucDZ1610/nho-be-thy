const chatHistory = document.getElementById('chatHistory');
const chatCount = document.getElementById('chatCount');
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('sendButton');
const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const notice = document.getElementById('notice');
const authView = document.getElementById('authView');
const authNotice = document.getElementById('authNotice');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const deleteConfirmOverlay = document.getElementById('deleteConfirmOverlay');
const deleteConfirmMessage = document.getElementById('deleteConfirmMessage');
const confirmDeleteButton = document.getElementById('confirmDeleteButton');
const welcomeMarkup = document.getElementById('welcome').outerHTML;

let chats = [];
let activeChat = null;
let currentUser = null;
let selectedImage = null;
let isSending = false;
let activeRequestController = null;
let activeAssistantStream = null;
let pendingDeleteId = null;
let deleteDialogTrigger = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Yêu cầu không thành công.');
    error.data = data;
    error.status = response.status;
    if (response.status === 401 && path !== '/api/auth/me') showAuth('login', data.error);
    throw error;
  }
  return data;
}

function showAuth(mode = 'login', message = '') {
  authView.hidden = false;
  document.getElementById('appShell').hidden = true;
  loginForm.hidden = mode !== 'login';
  registerForm.hidden = mode !== 'register';
  document.getElementById('loginTab').classList.toggle('active', mode === 'login');
  document.getElementById('registerTab').classList.toggle('active', mode === 'register');
  document.getElementById('loginTab').setAttribute('aria-selected', String(mode === 'login'));
  document.getElementById('registerTab').setAttribute('aria-selected', String(mode === 'register'));
  document.getElementById('authTitle').textContent = mode === 'login' ? 'Chào mừng bạn' : 'Tạo tài khoản';
  document.getElementById('authSubtitle').textContent = mode === 'login'
    ? 'Đăng nhập để mở các cuộc trò chuyện của bạn.'
    : 'Tạo tài khoản để lưu riêng các cuộc trò chuyện.';
  authNotice.textContent = message;
  authNotice.hidden = !message;
  if (window.lucide) lucide.createIcons();
  (mode === 'login' ? document.getElementById('loginUsername') : document.getElementById('registerName')).focus();
}

async function showApp(user) {
  currentUser = user;
  authView.hidden = true;
  document.getElementById('appShell').hidden = false;
  document.getElementById('accountName').textContent = user.name;
  showNotice();
  renderChat();
  await loadChats();
  await refreshOllamaStatus();
}

function updatePasswordStrength() {
  const password = document.getElementById('registerPassword').value;
  const confirm = document.getElementById('registerPasswordConfirm').value;
  const rules = {
    length: password.length >= 12,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password)
  };
  const strength = Object.values(rules).filter(Boolean).length;
  document.querySelectorAll('[data-password-rule]').forEach((item) => {
    item.classList.toggle('met', rules[item.dataset.passwordRule]);
  });
  const strengthBar = document.getElementById('passwordStrengthBar');
  strengthBar.style.width = `${strength * 20}%`;
  strengthBar.style.background = strength === 5 ? '#a5e0bb' : strength >= 3 ? '#d9bb78' : '#dc736c';
  document.getElementById('passwordStrengthText').textContent = strength === 5 ? 'Mật khẩu mạnh' : 'Chưa đạt yêu cầu';
  document.getElementById('registerSubmit').disabled = strength !== 5 || !confirm || password !== confirm;
}

async function submitLogin(event) {
  event.preventDefault();
  const submitButton = loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  authNotice.hidden = true;
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('loginUsername').value,
        password: document.getElementById('loginPassword').value
      })
    });
    loginForm.reset();
    await showApp(result.user);
  } catch (error) {
    authNotice.textContent = error.message;
    authNotice.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
}

async function submitRegistration(event) {
  event.preventDefault();
  updatePasswordStrength();
  if (document.getElementById('registerSubmit').disabled) return;
  const submitButton = document.getElementById('registerSubmit');
  submitButton.disabled = true;
  authNotice.hidden = true;
  try {
    const result = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('registerName').value,
        username: document.getElementById('registerUsername').value,
        password: document.getElementById('registerPassword').value,
        passwordConfirm: document.getElementById('registerPasswordConfirm').value
      })
    });
    registerForm.reset();
    updatePasswordStrength();
    await showApp(result.user);
  } catch (error) {
    authNotice.textContent = error.message;
    authNotice.hidden = false;
  } finally {
    updatePasswordStrength();
  }
}

async function logout() {
  if (activeRequestController) stopGeneration();
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Clear the local view even if the session has already expired.
  }
  currentUser = null;
  activeChat = null;
  chats = [];
  renderHistory();
  renderChat();
  showAuth('login');
}

function showNotice(message = '') {
  notice.textContent = message;
  notice.hidden = !message;
}

function updateControls() {
  sendButton.disabled = false;
  sendButton.classList.toggle('stop', isSending);
  sendButton.title = isSending ? 'Dừng câu trả lời' : 'Gửi tin nhắn';
  sendButton.setAttribute('aria-label', sendButton.title);
  sendButton.innerHTML = `<i data-lucide="${isSending ? 'square' : 'arrow-up'}"></i>`;
  if (window.lucide) lucide.createIcons();
  document.getElementById('deleteChatButton').disabled = !activeChat;
  document.getElementById('connectionText').textContent = isSending ? 'ĐANG SUY NGHĨ' : 'SẴN SÀNG';
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function getUserInitials(name) {
  return String(name || 'BẠN')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] || '')
    .join('')
    .toLocaleUpperCase('vi-VN');
}

function renderMessage(message, { typewriter = false } = {}) {
  const row = document.createElement('article');
  row.className = `message-row ${message.role === 'user' ? 'user' : 'assistant'}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = message.role === 'user' ? getUserInitials(currentUser?.name) : '';
  if (message.role !== 'user') {
    const botIcon = document.createElement('i');
    botIcon.setAttribute('data-lucide', 'sparkles');
    avatar.append(botIcon);
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const name = document.createElement('span');
  name.className = 'message-name';
  name.textContent = message.role === 'user' ? currentUser?.name || 'BẠN' : 'THUCGPT';
  const time = document.createElement('span');
  time.textContent = formatTime(message.createdAt);
  meta.append(name, time);

  const bubble = document.createElement('div');
  bubble.className = `message-bubble${typewriter ? ' typing' : ''}`;
  bubble.textContent = typewriter ? '' : message.content || '';
  if (message.image) {
    const image = document.createElement('img');
    image.className = 'message-image';
    image.src = message.image;
    image.alt = 'Ảnh người dùng đính kèm';
    bubble.append(image);
  }
  content.append(meta, bubble);
  row.append(avatar, content);
  return row;
}

function renderChat() {
  chatMessages.replaceChildren();
  if (!activeChat || activeChat.messages.length === 0) {
    chatMessages.innerHTML = welcomeMarkup;
  } else {
    activeChat.messages.forEach((message) => chatMessages.append(renderMessage(message)));
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  if (window.lucide) lucide.createIcons();
  updateControls();
}

function renderHistory() {
  chatHistory.replaceChildren();
  chatCount.textContent = String(chats.length);
  if (chats.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'Tin nhắn đầu tiên sẽ tạo lịch sử trò chuyện tại đây.';
    chatHistory.append(empty);
    return;
  }

  chats.forEach((chat) => {
    const row = document.createElement('div');
    row.className = `history-item${activeChat?.id === chat.id ? ' active' : ''}`;
    const openButton = document.createElement('button');
    openButton.className = 'history-open';
    openButton.type = 'button';
    openButton.title = chat.title;
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'message-square');
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = chat.title;
    openButton.append(icon, title);
    openButton.addEventListener('click', () => openChat(chat.id));

    const removeButton = document.createElement('button');
    removeButton.className = 'icon-button history-delete';
    removeButton.type = 'button';
    removeButton.title = 'Xóa cuộc trò chuyện';
    removeButton.setAttribute('aria-label', `Xóa ${chat.title}`);
    const removeIcon = document.createElement('i');
    removeIcon.setAttribute('data-lucide', 'x');
    removeButton.append(removeIcon);
    removeButton.addEventListener('click', () => requestDeleteChat(chat.id));

    row.append(openButton, removeButton);
    chatHistory.append(row);
  });
  if (window.lucide) lucide.createIcons();
}

async function loadChats() {
  chats = await api('/api/chats');
  renderHistory();
}

async function openChat(id) {
  try {
    activeChat = await api(`/api/chats/${encodeURIComponent(id)}`);
    showNotice();
    renderChat();
    renderHistory();
    closeSidebar();
  } catch (error) {
    showNotice(error.message);
  }
}

function startNewChat() {
  activeChat = null;
  showNotice();
  renderChat();
  renderHistory();
  userInput.focus();
  closeSidebar();
}

async function deleteChat(id) {
  try {
    await api(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
    chats = chats.filter((chat) => chat.id !== id);
    if (activeChat?.id === id) activeChat = null;
    renderChat();
    renderHistory();
    showNotice();
  } catch (error) {
    showNotice(error.message);
  }
}

function requestDeleteChat(id) {
  const target = chats.find((chat) => chat.id === id) || (activeChat?.id === id ? activeChat : null);
  if (!target) return;
  pendingDeleteId = id;
  deleteDialogTrigger = document.activeElement;
  deleteConfirmMessage.textContent = `Bạn có chắc muốn xóa “${target.title}” không?`;
  deleteConfirmOverlay.hidden = false;
  confirmDeleteButton.focus();
}

function closeDeleteDialog() {
  deleteConfirmOverlay.hidden = true;
  pendingDeleteId = null;
  if (deleteDialogTrigger instanceof HTMLElement) deleteDialogTrigger.focus();
  deleteDialogTrigger = null;
}

function setImage(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    showNotice('Chỉ hỗ trợ ảnh PNG, JPG, WEBP hoặc GIF.');
    imageInput.value = '';
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showNotice('Ảnh phải nhỏ hơn 8 MB.');
    imageInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    selectedImage = { name: file.name, dataUrl: reader.result };
    document.getElementById('imagePreviewThumb').src = reader.result;
    document.getElementById('imagePreviewName').textContent = file.name;
    imagePreview.hidden = false;
    showNotice();
  });
  reader.readAsDataURL(file);
}

function removeImage() {
  selectedImage = null;
  imageInput.value = '';
  imagePreview.hidden = true;
}

function createStreamedAssistant() {
  const row = renderMessage({ role: 'assistant', content: 'Đang suy nghĩ...', createdAt: new Date().toISOString() });
  const bubble = row.querySelector('.message-bubble');
  bubble.classList.add('waiting');
  chatMessages.append(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  const stream = { bubble, queue: [], timer: null, finished: false, failed: false };
  stream.finishedTyping = new Promise((resolve) => { stream.resolveTyping = resolve; });
  return stream;
}

function queueAssistantText(stream, text) {
  if (!text) return;
  if (stream.bubble.classList.contains('waiting')) {
    stream.bubble.textContent = '';
    stream.bubble.classList.remove('waiting');
    stream.bubble.classList.add('typing');
    document.getElementById('connectionText').textContent = 'ĐANG TRẢ LỜI';
  }
  stream.queue.push(...Array.from(text));
  if (stream.timer) return;

  stream.timer = setInterval(() => {
    if (stream.queue.length) {
      stream.bubble.textContent += stream.queue.shift();
      chatMessages.scrollTop = chatMessages.scrollHeight;
    } else if (stream.finished) {
      clearInterval(stream.timer);
      stream.timer = null;
      stream.bubble.classList.remove('typing');
      stream.resolveTyping();
    }
  }, 100);
}

function finishAssistantStream(stream) {
  stream.finished = true;
  if (!stream.timer && !stream.queue.length) {
    stream.bubble.classList.remove('waiting', 'typing');
    stream.resolveTyping();
  }
}

function stopAssistantStream(stream) {
  if (!stream) return;
  if (stream.queue.length) {
    stream.bubble.textContent += stream.queue.join('');
    stream.queue.length = 0;
  }
  stream.finished = true;
  if (stream.timer) clearInterval(stream.timer);
  stream.timer = null;
  stream.bubble.classList.remove('waiting', 'typing');
  stream.resolveTyping();
}

function stopGeneration() {
  if (!activeRequestController) return;
  activeRequestController.abort();
  stopAssistantStream(activeAssistantStream);
  if (activeAssistantStream?.bubble.textContent === 'Đang suy nghĩ...') {
    activeAssistantStream.bubble.textContent = 'Đã dừng trả lời.';
  }
}

async function receiveChatStream(payload, stream, signal) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const data = await response.json();
    const error = new Error(data.error || 'Yêu cầu không thành công.');
    error.data = data;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chatId = payload.chatId;

  function handleEvent(frame) {
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) return;
    const event = JSON.parse(dataLine.slice(6));
    if (event.type === 'start') {
      chatId = event.chat.id;
      activeChat = { ...event.chat, messages: [] };
      loadChats().catch(() => {});
      updateControls();
    } else if (event.type === 'token') {
      queueAssistantText(stream, event.content);
    } else if (event.type === 'error') {
      throw new Error(event.error);
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    frames.forEach(handleEvent);
    if (done) break;
  }
  if (buffer.trim()) handleEvent(buffer);
  finishAssistantStream(stream);
  await stream.finishedTyping;
  if (!chatId) throw new Error('Không nhận được mã cuộc trò chuyện từ máy chủ.');
  return api(`/api/chats/${encodeURIComponent(chatId)}`);
}

async function sendMessage(event) {
  event.preventDefault();
  const content = userInput.value.trim();
  if ((!content && !selectedImage) || isSending) return;

  const image = selectedImage?.dataUrl || null;
  userInput.value = '';
  userInput.style.height = 'auto';
  removeImage();
  showNotice();
  isSending = true;
  updateControls();

  document.getElementById('welcome')?.remove();
  chatMessages.append(renderMessage({
    role: 'user',
    content,
    image,
    createdAt: new Date().toISOString()
  }));
  const assistantStream = createStreamedAssistant();
  activeRequestController = new AbortController();
  activeAssistantStream = assistantStream;
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    activeChat = await receiveChatStream({ chatId: activeChat?.id || null, content, image }, assistantStream, activeRequestController.signal);
    await loadChats();
    renderChat();
  } catch (error) {
    if (error.name === 'AbortError') {
      stopAssistantStream(assistantStream);
      if (assistantStream.bubble.textContent === 'Đang suy nghĩ...') assistantStream.bubble.textContent = 'Đã dừng trả lời.';
    } else {
      finishAssistantStream(assistantStream);
      if (error.data?.chat) {
        activeChat = error.data.chat;
        await loadChats();
        renderChat();
      } else if (!assistantStream.bubble.textContent.trim() || assistantStream.bubble.textContent === 'Đang suy nghĩ...') {
        assistantStream.bubble.classList.remove('waiting', 'typing');
        assistantStream.bubble.textContent = 'Không thể nhận câu trả lời.';
      }
      showNotice(error.message);
    }
  } finally {
    activeRequestController = null;
    activeAssistantStream = null;
    isSending = false;
    updateControls();
    userInput.focus();
  }
}

async function refreshOllamaStatus() {
  const light = document.getElementById('modelStatusLight');
  const label = document.getElementById('modelStatus');
  const model = document.getElementById('modelName');
  try {
    const status = await api('/api/health');
    model.textContent = status.model;
    if (status.connected && status.modelReady) {
      light.className = 'status-light online';
      label.textContent = 'Ollama sẵn sàng';
    } else if (status.connected) {
      light.className = 'status-light offline';
      label.textContent = 'Chưa tải model';
    } else {
      light.className = 'status-light offline';
      label.textContent = 'Ollama chưa chạy';
    }
  } catch {
    light.className = 'status-light offline';
    label.textContent = 'Không kết nối backend';
  }
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('open');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

document.getElementById('newChatButton').addEventListener('click', startNewChat);
document.getElementById('loginTab').addEventListener('click', () => showAuth('login'));
document.getElementById('registerTab').addEventListener('click', () => showAuth('register'));
document.getElementById('logoutButton').addEventListener('click', logout);
loginForm.addEventListener('submit', submitLogin);
registerForm.addEventListener('submit', submitRegistration);
document.getElementById('registerPassword').addEventListener('input', updatePasswordStrength);
document.getElementById('registerPasswordConfirm').addEventListener('input', updatePasswordStrength);
document.getElementById('deleteChatButton').addEventListener('click', () => activeChat && requestDeleteChat(activeChat.id));
document.getElementById('cancelDeleteButton').addEventListener('click', closeDeleteDialog);
confirmDeleteButton.addEventListener('click', async () => {
  const id = pendingDeleteId;
  closeDeleteDialog();
  if (id) await deleteChat(id);
});
deleteConfirmOverlay.addEventListener('click', (event) => {
  if (event.target === deleteConfirmOverlay) closeDeleteDialog();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !deleteConfirmOverlay.hidden) closeDeleteDialog();
});
sendButton.addEventListener('click', (event) => {
  if (isSending) {
    event.preventDefault();
    stopGeneration();
  }
});
document.getElementById('attachButton').addEventListener('click', () => imageInput.click());
document.getElementById('removeImageButton').addEventListener('click', removeImage);
document.getElementById('refreshStatus').addEventListener('click', refreshOllamaStatus);
document.getElementById('openSidebar').addEventListener('click', openSidebar);
document.getElementById('closeSidebar').addEventListener('click', closeSidebar);
document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);
imageInput.addEventListener('change', (event) => setImage(event.target.files[0]));
chatForm.addEventListener('submit', sendMessage);
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = `${Math.min(userInput.scrollHeight, 150)}px`;
});
userInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) lucide.createIcons();
  updatePasswordStrength();
  try {
    const { user } = await api('/api/auth/me');
    if (user) await showApp(user);
    else showAuth('login');
  } catch (error) {
    showAuth('login', error.message);
  }
});
