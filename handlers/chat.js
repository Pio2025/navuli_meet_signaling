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
}

module.exports = { registerChatHandlers };
