# ThucGPT

Giao diện chat AI chạy cục bộ, dùng Ollama làm mô hình và Node.js làm backend. Lịch sử chat được lưu trong `backend/data/chats.json`; một cuộc trò chuyện chỉ xuất hiện trong danh sách sau khi gửi tin nhắn đầu tiên.

## Chạy ứng dụng

Yêu cầu: Node.js 18 trở lên và Ollama.

```bash
ollama serve
```

Trong terminal khác, tải model văn bản nhẹ mặc định và chạy web:

```bash
ollama pull qwen2.5:0.5b
ollama pull qwen2.5vl:3b
node backend/server.js
```

Mở `http://localhost:3000`. Backend không cần cài package npm.

Chat văn bản dùng `qwen2.5:0.5b`; khi đính kèm ảnh, ứng dụng dùng `qwen2.5vl:3b`. Có thể đổi bằng `OLLAMA_MODEL` và `OLLAMA_VISION_MODEL`; đổi cổng web bằng `PORT`. Hỗ trợ ảnh PNG, JPG, WEBP hoặc GIF (tối đa 8 MB).