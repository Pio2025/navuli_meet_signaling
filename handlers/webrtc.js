function registerWebRTCHandlers(io, socket, rooms) {

  // Called by a peer once it has connected to Cloudflare SFU and published tracks.
  // We store the session info so late-joiners receive it in their 'admitted' payload,
  // then broadcast to everyone already in the room so they can subscribe.
  socket.on('sfu-session-ready', ({ sessionId, trackNames }) => {
    if (!socket.meetingUuid) return;

    rooms.setSfuSession(socket.meetingUuid, socket.id, sessionId, trackNames);

    // Use currentRoom so peers inside a breakout only hear from their own room.
    // Falls back to meetingUuid when not in a breakout.
    const targetRoom = socket.currentRoom || socket.meetingUuid;
    socket.to(targetRoom).emit('peer-sfu-ready', {
      socketId: socket.id,
      sessionId,
      trackNames,
    });

    console.log(`[sfu] READY  meeting=${socket.meetingUuid}  room=${targetRoom}  socket=${socket.id}  session=${sessionId}`);
  });
}

module.exports = { registerWebRTCHandlers };
