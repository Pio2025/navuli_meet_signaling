function registerChatHandlers(io, socket, rooms) {

  socket.on('chat-message', ({ message, fileUrl, fileName, fileType, fileSize }) => {
    if (!socket.meetingUuid) return;
    const hasText = message?.trim();
    const hasFile = fileUrl?.trim();
    if (!hasText && !hasFile) return;

    const safe = hasText ? String(message).slice(0, 2000).replace(/<[^>]+>/g, '') : '';
    const info = rooms.getAdmitted(socket.meetingUuid)
      .find(p => p.socketId === socket.id);

    const payload = {
      socketId:   socket.id,
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
