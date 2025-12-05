const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

// Home Route
app.get("/", (req, res) => {
  res.send("ChatItNow Server is Running!");
});

const server = http.createServer(app);

// Cloud port configuration
const PORT = process.env.PORT || 3001;

// 10 Minutes in milliseconds
const INACTIVITY_LIMIT = 10 * 60 * 1000; 

const io = new Server(server, {
  // This helps mobile stay connected if signal drops
  connectionStateRecovery: {
    maxDisconnectionDuration: INACTIVITY_LIMIT,
    skipMiddlewares: true,
  },
  // This kills dead connections (network loss)
  pingTimeout: INACTIVITY_LIMIT, 
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

// --- IDLE CHECKER (Applies to Desktop & Mobile) ---
// This ensures users are kicked if they are truly idle (not typing/interacting)
setInterval(() => {
  const now = Date.now();
  io.sockets.sockets.forEach((socket) => {
    if (socket.lastActive && (now - socket.lastActive > INACTIVITY_LIMIT)) {
      console.log(`Disconnecting inactive user: ${socket.id}`);
      socket.disconnect(true);
    }
  });
}, 60 * 1000); // Check every minute

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

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Track activity
  socket.lastActive = Date.now();

  if (socket.recovered) {
    console.log(`User ${socket.id} recovered connection`);
  }

  // Update activity on any event
  socket.onAny(() => {
    socket.lastActive = Date.now();
  });

  socket.on('find_partner', (userData) => {
    socket.userData = userData; 
    socket.lastActive = Date.now();

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
      const queueItem = {
        socket: socket,
        userData: userData,
        openToAny: false 
      };
      
      waitingQueue.push(queueItem);

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
        type: 'stranger'
      });
    }
  });

  socket.on('typing', (isTyping) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('partner_typing', isTyping);
    }
  });

  const handleDisconnect = (userSocket) => {
    waitingQueue = waitingQueue.filter(s => s.socket.id !== userSocket.id);

    if (userSocket.roomID) {
      userSocket.to(userSocket.roomID).emit('partner_disconnected');
      
      const room = io.sockets.adapter.rooms.get(userSocket.roomID);
      if (room) {
        for (const id of room) {
          const s = io.sockets.sockets.get(id);
          if (s) { s.leave(userSocket.roomID); s.roomID = null; }
        }
      }
      userSocket.roomID = null;
    }
  };

  socket.on('disconnect_partner', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', (reason) => {
    console.log(`User ${socket.id} disconnected. Reason: ${reason}`);
    handleDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});