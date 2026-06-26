function registerChatHandlers(io, socket, rooms) {

  socket.on('chat-message', ({ message }) => {
    if (!socket.meetingUuid || !message?.trim()) return;
    const safe = String(message).slice(0, 2000).replace(/<[^>]+>/g, '');
    const info = rooms.getAdmitted(socket.meetingUuid)
      .find(p => p.socketId === socket.id);

    const payload = {
      socketId:   socket.id,
      senderName: info?.displayName ?? 'Guest',
      message:    safe,
      timestamp:  new Date().toISOString(),
    };

    // Broadcast to others in the room
    socket.to(socket.meetingUuid).emit('chat-message', payload);
  });
}

module.exports = { registerChatHandlers };
