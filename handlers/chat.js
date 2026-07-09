const backendApi = require('../services/backendApi');

function registerChatHandlers(io, socket, rooms) {

  socket.on('chat-message', ({ messageId, message, fileUrl, fileName, fileType, fileSize }) => {
    if (!socket.meetingUuid) return;
    const hasText = message?.trim();
    const hasFile = fileUrl?.trim();
    if (!hasText && !hasFile) return;

    const safe = hasText ? String(message).slice(0, 2000).replace(/<[^>]+>/g, '') : '';
    const info = rooms.getAdmitted(socket.meetingUuid)
      .find(p => p.socketId === socket.id);

    const payload = {
      socketId:   socket.id,
      messageId,
      senderName: info?.displayName ?? 'Guest',
      message:    safe,
      timestamp:  new Date().toISOString(),
      fileUrl,
      fileName,
      fileType,
      fileSize,
    };

    // Broadcast to others in the room
    socket.to(socket.meetingUuid).emit('chat-message', payload);

    // Persist to the DB (fire-and-forget — must not block the live broadcast)
    backendApi.sendChat(socket.handshake.auth?.token, socket.meetingUuid, {
      message: safe,
      attachment_url: hasFile ? fileUrl : undefined,
      attachment_name: hasFile ? fileName : undefined,
      attachment_mime: hasFile ? fileType : undefined,
      attachment_size: hasFile ? fileSize : undefined,
    });
  });

  // Emoji reactions on a chat message — pure relay, keyed by the client-
  // generated messageId shared in the 'chat-message' payload above. Not
  // persisted (matches the existing poll relay's ephemeral-only model).
  socket.on('chat-reaction', ({ messageId, emoji }) => {
    if (!socket.meetingUuid || !messageId || !emoji) return;
    socket.to(socket.meetingUuid).emit('chat-reaction-update', {
      socketId: socket.id, messageId, emoji,
    });
  });

  socket.on('typing-start', () => {
    if (!socket.meetingUuid) return;
    const info = rooms.getAdmitted(socket.meetingUuid).find(p => p.socketId === socket.id);
    socket.to(socket.meetingUuid).emit('peer-typing', {
      socketId:   socket.id,
      senderName: info?.displayName ?? 'Guest',
      isTyping:   true,
    });
  });

  socket.on('typing-stop', () => {
    if (!socket.meetingUuid) return;
    socket.to(socket.meetingUuid).emit('peer-typing', {
      socketId: socket.id,
      isTyping: false,
    });
  });
}

module.exports = { registerChatHandlers };
