// Real-time relay for VTalanoa Workspace Team Chat.
// No SFU — pure Socket.IO message relay for persistent channels.

function registerWorkspaceHandlers(io, socket) {

  // Join a channel room to receive real-time messages
  socket.on('ws-join-channel', ({ channelId }) => {
    if (!channelId) return;
    const roomId = `ws:ch:${channelId}`;
    socket.join(roomId);
    socket.wsChannels = socket.wsChannels || new Set();
    socket.wsChannels.add(roomId);
  });

  // Leave a channel room (e.g. when switching channels)
  socket.on('ws-leave-channel', ({ channelId }) => {
    const roomId = `ws:ch:${channelId}`;
    socket.leave(roomId);
    socket.wsChannels?.delete(roomId);
  });

  // Relay a persisted message to all other members of the channel
  socket.on('ws-message', ({ channelId, message }) => {
    if (!channelId || !message) return;
    const roomId = `ws:ch:${channelId}`;
    socket.to(roomId).emit('ws-message', { channelId, message });
  });

  // Real-time typing indicator
  socket.on('ws-typing', ({ channelId }) => {
    if (!channelId) return;
    const roomId = `ws:ch:${channelId}`;
    socket.to(roomId).emit('ws-typing', {
      channelId,
      userId:   socket.user?.user_id,
      userName: socket.user?.fname
        ? `${socket.user.fname} ${socket.user.lname || ''}`.trim()
        : (socket.user?.guest_name || 'Someone'),
    });
  });

  // Real-time mail notification — let the recipient know about new mail
  socket.on('ws-mail-notify', ({ toUserIds, subject, fromName }) => {
    if (!Array.isArray(toUserIds)) return;
    toUserIds.forEach(uid => {
      io.to(`ws:user:${uid}`).emit('ws-mail-notify', { subject, fromName });
    });
  });

  // Subscribe to personal notifications (mail, mentions)
  socket.on('ws-subscribe-user', ({ userId }) => {
    if (!userId) return;
    const roomId = `ws:user:${userId}`;
    socket.join(roomId);
  });

  // Realtime doc cursor (lightweight — no OT, just cursor position broadcast)
  socket.on('ws-doc-cursor', ({ docId, name, color }) => {
    const roomId = `ws:doc:${docId}`;
    socket.to(roomId).emit('ws-doc-cursor', { socketId: socket.id, name, color });
  });

  socket.on('ws-join-doc', ({ docId }) => {
    if (!docId) return;
    socket.join(`ws:doc:${docId}`);
  });

  socket.on('ws-leave-doc', ({ docId }) => {
    socket.leave(`ws:doc:${docId}`);
  });
}

module.exports = { registerWorkspaceHandlers };
