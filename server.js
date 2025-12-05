const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("ChatItNow Server is Running!");
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// 10 Minutes max session idle time
const INACTIVITY_LIMIT = 10 * 60 * 1000; 

// --- UPDATED: 1 Minute grace period for internet drops ---
const RECONNECT_GRACE_PERIOD = 60 * 1000; 

const io = new Server(server, {
  connectionStateRecovery: {
    // This allows the server to restore the socket session (ID, Rooms) 
    // if the client reconnects quickly.
    maxDisconnectionDuration: 2 * 60 * 1000, 
    skipMiddlewares: true,
  },
  pingTimeout: 60000, 
  pingInterval: 25000,
  cors: {
    origin: [
      "https://chatitnow.com",
      "https://www.chatitnow.com",
      "http://localhost:5173", 
      "https://chatitnow-frontend.vercel.app"
    ],
    methods: ["GET", "POST"]
  }
});

let waitingQueue = [];
// Store timeouts so we can cancel them if user reconnects
const disconnectTimers = new Map(); 

// --- IDLE CHECKER ---
setInterval(() => {
  const now = Date.now();
  io.sockets.sockets.forEach((socket) => {
    if (socket.lastActive && (now - socket.lastActive > INACTIVITY_LIMIT)) {
      socket.disconnect(true);
    }
  });
}, 60 * 1000);

const matchUsers = (socket1, socket2) => {
  const roomID = `${socket1.id}#${socket2.id}`;
  socket1.join(roomID);
  socket2.join(roomID);
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  waitingQueue = waitingQueue.filter(u => u.socket.id !== socket1.id && u.socket.id !== socket2.id);

  io.to(socket1.id).emit('matched', {
    name: socket2.userData.username,
    field: socket2.userData.field,
    roomID: roomID
  });

  io.to(socket2.id).emit('matched', {
    name: socket1.userData.username,
    field: socket1.userData.field,
    roomID: roomID
  });
};

// --- CLEANUP FUNCTION ---
const performDisconnect = (userSocket) => {
  // Remove from queue
  waitingQueue = waitingQueue.filter(s => s.socket.id !== userSocket.id);

  // Remove from timers
  if (disconnectTimers.has(userSocket.id)) {
    clearTimeout(disconnectTimers.get(userSocket.id));
    disconnectTimers.delete(userSocket.id);
  }

  // Notify partner and close room
  if (userSocket.roomID) {
    userSocket.to(userSocket.roomID).emit('partner_disconnected');
    
    const room = io.sockets.adapter.rooms.get(userSocket.roomID);
    if (room) {
      for (const id of room) {
        const s = io.sockets.sockets.get(id);
        if (s) { 
          s.leave(userSocket.roomID); 
          s.roomID = null; 
        }
      }
    }
    userSocket.roomID = null;
  }
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  socket.lastActive = Date.now();

  // --- RECOVERY LOGIC ---
  if (socket.recovered) {
    console.log(`User ${socket.id} recovered session`);
    // If they had a pending disconnect timer, CANCEL IT. They are back!
    if (disconnectTimers.has(socket.id)) {
      clearTimeout(disconnectTimers.get(socket.id));
      disconnectTimers.delete(socket.id);
    }
    // Tell the partner we are back
    if (socket.roomID) {
      socket.to(socket.roomID).emit('partner_connected'); 
    }
  }

  socket.onAny(() => {
    socket.lastActive = Date.now();
  });

  socket.on('find_partner', (userData) => {
    socket.userData = userData; 
    
    // Clear any existing disconnect timers just in case
    if (disconnectTimers.has(socket.id)) {
      clearTimeout(disconnectTimers.get(socket.id));
      disconnectTimers.delete(socket.id);
    }

    const isGenericField = userData.field === '' || userData.field === 'Others';

    setTimeout(() => {
      if (!socket.connected) return;

      // 1. PRIORITY MATCH
      if (!isGenericField) {
        const exactMatch = waitingQueue.find(user => 
          user.socket.id !== socket.id &&
          user.userData.field !== '' &&
          user.userData.field !== 'Others' && 
          user.userData.field === userData.field
        );

        if (exactMatch) {
          matchUsers(socket, exactMatch.socket);
          return;
        }
      }

      // 2. DESPERATION CHECK
      const desperateUser = waitingQueue.find(user => 
        user.socket.id !== socket.id &&
        user.openToAny === true
      );

      if (desperateUser) {
        matchUsers(socket, desperateUser.socket);
        return;
      }

      // 3. QUEUE USER
      waitingQueue.push({
        socket: socket,
        userData: userData,
        openToAny: false 
      });

      // DELAY 2 Config
      const priorityWaitTime = isGenericField ? 4000 : 3000;

      setTimeout(() => {
        const currentEntry = waitingQueue.find(u => u.socket.id === socket.id);
        if (currentEntry) {
          currentEntry.openToAny = true; 
          const extraBuffer = isGenericField ? 0 : 2000;

          setTimeout(() => {
             const finalEntry = waitingQueue.find(u => u.socket.id === socket.id);
             if (finalEntry) {
                const anyMatch = waitingQueue.find(u => u.socket.id !== socket.id);
                if (anyMatch) {
                  matchUsers(socket, anyMatch.socket);
                }
             }
          }, extraBuffer);
        }
      }, priorityWaitTime); 

    }, 3000); 
  });

  socket.on('send_message', (messageData) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('receive_message', {
        text: messageData.text,
        type: 'stranger',
        replyTo: messageData.replyTo 
      });
    }
  });

  socket.on('typing', (isTyping) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('partner_typing', isTyping);
    }
  });

  // User manually clicked "Next" / "Disconnect"
  socket.on('disconnect_partner', () => {
    performDisconnect(socket);
  });

  // Internet dropped or Tab closed
  socket.on('disconnect', (reason) => {
    console.log(`User ${socket.id} disconnected. Reason: ${reason}`);
    
    // If they are in a queue, remove them immediately
    waitingQueue = waitingQueue.filter(s => s.socket.id !== socket.id);

    // If they are in a chat, START GRACE TIMER
    if (socket.roomID) {
      // Notify partner that user is "Away/Reconnecting"
      socket.to(socket.roomID).emit('partner_reconnecting_server');

      // Wait 60 seconds (1 min) before actually killing the session
      const timer = setTimeout(() => {
        console.log(`Grace period over for ${socket.id}, killing session.`);
        performDisconnect(socket);
      }, RECONNECT_GRACE_PERIOD);

      disconnectTimers.set(socket.id, timer);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});