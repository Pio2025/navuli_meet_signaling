function registerWebRTCHandlers(io, socket, rooms) {

  // Called by a peer once it has connected to Cloudflare SFU and published tracks.
  // We store the session info so late-joiners receive it in their 'admitted' payload,
  // then broadcast to everyone already in the room so they can subscribe.
  socket.on('sfu-session-ready', ({ sessionId, trackNames }) => {
    if (!socket.meetingUuid) return;

    rooms.setSfuSession(socket.meetingUuid, socket.id, sessionId, trackNames);

    socket.to(socket.meetingUuid).emit('peer-sfu-ready', {
      socketId: socket.id,
      sessionId,
      trackNames,
    });

    console.log(`[sfu] READY  meeting=${socket.meetingUuid}  socket=${socket.id}  session=${sessionId}`);
  });
}

module.exports = { registerWebRTCHandlers };
